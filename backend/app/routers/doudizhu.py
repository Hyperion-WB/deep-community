"""Private, server-authoritative Dou Dizhu tables shared by all API workers."""

import json
import re
from datetime import datetime, timezone
from random import SystemRandom
from secrets import choice, token_urlsafe
from time import time
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, StrictInt
from redis.exceptions import RedisError, WatchError
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_redis, is_mock_redis
from app.models.user import User
from app.routers.deps import get_current_user, get_current_user_optional
from app.services.doudizhu import CARD_ORDER, DECK, DouDizhuError, DouDizhuGame

router = APIRouter(prefix="/doudizhu", tags=["斗地主"])
ROOM_TTL = 7200
GUEST_COOKIE = "wb_doudizhu_guest"
CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
INVITATION_TTL = 600
INVITATION_LIMIT = 30
INTERACTION_COOLDOWN = 3
NUDGE_IDLE_SECONDS = 10
INTERACTION_PRESETS = {
    "hello": ("chat", "大家好，很高兴一起打牌！"),
    "nice": ("chat", "这手牌打得漂亮！"),
    "thanks": ("chat", "谢谢队友！"),
    "think": ("chat", "让我想一想。"),
    "ready": ("chat", "我准备好了！"),
    "challenge": ("taunt", "这手牌你接得住吗？"),
    "close": ("taunt", "这一局可还没结束！"),
    "luck": ("taunt", "好运气会一直站在你这边吗？"),
    "your_turn": ("nudge", "轮到你啦！"),
    "waiting": ("nudge", "我们在等你出牌。"),
}


class CreateRoom(BaseModel):
    humans: StrictInt = Field(ge=1, le=3)


class RoomAction(BaseModel):
    revision: StrictInt = Field(ge=0)
    action: Literal["bid", "play", "pass", "restart", "leave"]
    bid: StrictInt | None = Field(default=None, ge=0, le=3)
    cards: list[StrictInt] = Field(default_factory=list, max_length=20)


class InvitationPayload(BaseModel):
    user_id: UUID


class InteractionPayload(BaseModel):
    kind: Literal["chat", "taunt", "nudge"]
    preset: str = Field(max_length=32)
    target_seat: StrictInt | None = Field(default=None, ge=0, le=2)


def _iso(timestamp: float | None) -> str | None:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat() if timestamp is not None else None


def _redis():
    redis = get_redis()
    if redis is None or is_mock_redis():
        raise HTTPException(503, "牌桌暂不可用，请稍后再试")
    return redis


def _identity(request: Request, user: User | None, response: Response | None = None) -> tuple[str, str]:
    if user is not None:
        if user.status in {"banned", "deactivated"} or user.must_change_password:
            raise HTTPException(403, "当前社区账号无法进入牌桌")
        return str(user.id), user.nickname or user.username
    guest_token = request.cookies.get(GUEST_COOKIE, "")
    if response is not None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", guest_token):
            guest_token = token_urlsafe(32)
        response.set_cookie(
            GUEST_COOKIE, guest_token, max_age=ROOM_TTL, httponly=True,
            secure=request.url.scheme == "https", samesite="lax", path="/api/doudizhu",
        )
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", guest_token):
        raise HTTPException(404, "牌桌已失效或您尚未入座")
    return f"guest:{guest_token}", "访客"


def _key(code: str) -> str:
    code = code.upper()
    if len(code) != 6 or any(char not in CODE_ALPHABET for char in code):
        raise HTTPException(404, "未找到牌桌")
    return f"doudizhu:room:{code}"


def _seat(room: dict, identity: str) -> int | None:
    return next((seat for seat, player in enumerate(room["players"]) if player["id"] == identity), None)


def _start(room: dict, starting_seat: int | None = None) -> DouDizhuGame:
    return DouDizhuGame(range(room["humans"], 3), rng=SystemRandom(), starting_seat=starting_seat)


def _advance(room: dict, game: DouDizhuGame) -> None:
    for _ in range(12):
        if not game.step_ai():
            break
    room["game"] = game.to_dict()
    room["turn_started_at"] = time()


def _snapshot(room: dict, me: int, game: DouDizhuGame | None = None) -> dict:
    phase = "closed" if room["closed"] else "waiting"
    view = game.snapshot(me) if game and not room["closed"] else {}
    players = [{"name": player["name"], "avatar_url": player.get("avatar_url"), "ai": False, "seat": seat}
               for seat, player in enumerate(room["players"])]
    players.extend({"name": f"电脑 {seat - room['humans'] + 1}", "ai": True, "seat": seat}
                   for seat in range(room["humans"], 3))
    for player in players:
        player["count"] = view.get("hand_counts", [0, 0, 0])[player["seat"]]
    last = view.get("last_play")
    hints = game.hints(me) if view and game else []
    return {
        "code": room["code"], "humans": room["humans"], "host": me == 0,
        "revision": room["revision"], "me": me, "players": players,
        "phase": view.get("phase", phase), "turn": view.get("turn"),
        "landlord": view.get("landlord"), "bid": view.get("highest_bid", 0),
        "hand": [CARD_ORDER[card] for card in view.get("hand", [])],
        "bottom": [CARD_ORDER[card] for card in view.get("bottom_cards", [])],
        "last": {"seat": last["seat"], "cards": [CARD_ORDER[card] for card in last["cards"]]} if last else None,
        "winner": view.get("winning_side"),
        "hint": [CARD_ORDER[card] for card in hints[0]] if hints else [],
        "canPass": view.get("phase") == "playing" and view.get("turn") == me and last is not None,
        "interactions": [event for event in room.get("interactions", [])
                         if event["target_seat"] is None or me in (event["from_seat"], event["target_seat"])],
        "turn_started_at": _iso(room.get("turn_started_at")) if view.get("phase") in {"bidding", "playing"} else None,
        "nudge_idle_seconds": NUDGE_IDLE_SECONDS,
        "interaction_cooldown_seconds": INTERACTION_COOLDOWN,
    }


@router.post("/rooms", status_code=201)
async def create_room(payload: CreateRoom, request: Request, response: Response,
                      user: User | None = Depends(get_current_user_optional)):
    if user is None and payload.humans > 1:
        raise HTTPException(403, "好友对战使用当前社区账号")
    identity, name = _identity(request, user, response)
    redis = _redis()
    source = str(user.id) if user is not None else (request.client.host if request.client else "unknown")
    rate_key = f"doudizhu:create:{source}"
    async with redis.pipeline(transaction=True) as pipe:
        created, _ = await pipe.incr(rate_key).expire(rate_key, 60, nx=True).execute()
    if created > 30:
        raise HTTPException(429, "开桌太频繁，请稍后再试")
    for _ in range(8):
        code = "".join(choice(CODE_ALPHABET) for _ in range(6))
        room = {"code": code, "id": str(uuid4()), "humans": payload.humans,
                "players": [{"id": identity, "name": name, "avatar_url": user.avatar_url if user else None}],
                "revision": 0, "game": None, "closed": False}
        game = _start(room) if payload.humans == 1 else None
        if game:
            _advance(room, game)
        if await redis.set(_key(code), json.dumps(room), nx=True, ex=ROOM_TTL):
            return _snapshot(room, 0, game)
    raise HTTPException(503, "暂时无法创建牌桌，请重试")


def _read(raw: str | None) -> dict:
    if raw is None:
        raise HTTPException(404, "牌桌不存在或已过期")
    return json.loads(raw)


@router.get("/rooms/{code}")
async def get_room(code: str, request: Request, response: Response,
                   user: User | None = Depends(get_current_user_optional)):
    response.headers["Cache-Control"] = "private, no-store"
    identity, _ = _identity(request, user)
    room = _read(await _redis().get(_key(code)))
    seat = _seat(room, identity)
    if seat is None:
        raise HTTPException(404, "您尚未在此牌桌入座")
    return _snapshot(room, seat, DouDizhuGame.from_dict(room["game"]) if room["game"] else None)


async def _update(code: str, mutate, *, bump_revision: bool = True):
    key = _key(code)
    for _ in range(5):
        async with _redis().pipeline() as pipe:
            try:
                await pipe.watch(key)
                room = _read(await pipe.get(key))
                game = DouDizhuGame.from_dict(room["game"]) if room["game"] else None
                seat, game, changed = mutate(room, game)
                if changed:
                    if bump_revision:
                        room["revision"] += 1
                    pipe.multi()
                    pipe.set(key, json.dumps(room), ex=ROOM_TTL)
                    await pipe.execute()
                return _snapshot(room, seat, game)
            except WatchError:
                continue
    raise HTTPException(409, "牌桌状态正在更新，请重试")


def _join(room: dict, game: DouDizhuGame | None, identity: str, name: str, avatar_url: str | None = None):
    if room["closed"]:
        raise HTTPException(409, "牌桌已关闭")
    seat = _seat(room, identity)
    if seat is not None:
        return seat, game, False
    if len(room["players"]) >= room["humans"]:
        raise HTTPException(409, "牌桌已满")
    seat = len(room["players"])
    room["players"].append({"id": identity, "name": name, "avatar_url": avatar_url})
    if len(room["players"]) == room["humans"]:
        game = _start(room)
        _advance(room, game)
    return seat, game, True


@router.post("/rooms/{code}/join")
async def join_room(code: str, request: Request, user: User | None = Depends(get_current_user_optional)):
    if user is None:
        raise HTTPException(403, "好友对战使用当前社区账号")
    identity, name = _identity(request, user)
    return await _update(code, lambda room, game: _join(room, game, identity, name, user.avatar_url))


@router.get("/lobby/users")
async def lobby_users(
    response: Response,
    q: str = Query("", max_length=64),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    response.headers["Cache-Control"] = "private, no-store"
    term = q.strip()
    if not term:
        return {"items": []}
    rows = (await db.execute(
        select(User.id, User.username, User.nickname, User.avatar_url)
        .where(
            User.id != user.id,
            User.status.in_(("active", "probation")),
            User.is_bot.is_(False),
            User.must_change_password.is_(False),
            or_(User.username.icontains(term, autoescape=True), User.nickname.icontains(term, autoescape=True)),
        )
        .order_by(User.username)
        .limit(20)
    )).all()
    online = [None] * len(rows)
    redis = get_redis()
    if redis is not None and not is_mock_redis() and rows:
        try:
            online = await redis.mget([f"online:user:{row.id}" for row in rows])
        except RedisError:
            pass
    return {"items": [
        {"user_id": str(row.id), "username": row.username, "nickname": row.nickname or row.username,
         "avatar_url": row.avatar_url or "", "online": presence is not None}
        for row, presence in zip(rows, online)
    ]}


def _inbox_key(user_id: UUID) -> str:
    return f"doudizhu:invitations:{user_id}"


def _read_inbox(raw: str | None) -> list[dict]:
    now = time()
    return [item for item in json.loads(raw) if item["expires_at"] > now] if raw else []


def _invitation_view(item: dict) -> dict:
    return {"id": item["id"], "code": item["code"], "inviter_name": item["inviter_name"],
            "expires_at": _iso(item["expires_at"])}


def _invitation_matches_room(invitation: dict, room: dict) -> bool:
    return invitation["code"] == room["code"] and invitation["room_id"] == room.get("id") and (
        _seat(room, invitation["inviter_id"]) == 0
    )


@router.get("/invitations")
async def invitation_inbox(response: Response, user: User = Depends(get_current_user)):
    response.headers["Cache-Control"] = "private, no-store"
    redis = _redis()
    pending = [item for item in _read_inbox(await redis.get(_inbox_key(user.id))) if item["status"] == "pending"]
    if not pending:
        return {"items": []}
    rooms = await redis.mget([_key(item["code"]) for item in pending])
    items = []
    for invitation, raw_room in zip(pending, rooms):
        if raw_room is None:
            continue
        room = _read(raw_room)
        if not room["closed"] and _invitation_matches_room(invitation, room) and (
            len(room["players"]) < room["humans"] or _seat(room, str(user.id)) is not None
        ):
            items.append(_invitation_view(invitation))
    return {"items": items}


@router.post("/rooms/{code}/invitations", status_code=201)
async def invite_user(
    code: str,
    payload: InvitationPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if payload.user_id == user.id:
        raise HTTPException(400, "不能邀请自己入座")
    target = await db.scalar(select(User.id).where(
        User.id == payload.user_id, User.status.in_(("active", "probation")),
        User.is_bot.is_(False), User.must_change_password.is_(False),
    ))
    if target is None:
        raise HTTPException(404, "该用户当前无法受邀")
    redis = _redis()
    room_key = _key(code)
    inbox_key = _inbox_key(target)
    rate_key = f"doudizhu:invite-rate:{user.id}"
    for _ in range(5):
        async with redis.pipeline() as pipe:
            try:
                await pipe.watch(room_key, inbox_key, rate_key)
                raw_room, raw_inbox, raw_rate = await pipe.mget([room_key, inbox_key, rate_key])
                room = _read(raw_room)
                if _seat(room, str(user.id)) != 0:
                    raise HTTPException(403, "只有房主可以发送邀请")
                if room["closed"] or len(room["players"]) >= room["humans"]:
                    raise HTTPException(409, "当前牌桌无法邀请玩家")
                if _seat(room, str(target)) is not None:
                    raise HTTPException(409, "该用户已经入座")
                inbox = _read_inbox(raw_inbox)
                existing = next((item for item in inbox if item["status"] == "pending"
                                 and _invitation_matches_room(item, room)), None)
                if existing:
                    return _invitation_view(existing)
                if int(raw_rate or 0) >= 12:
                    raise HTTPException(429, "邀请发送太频繁，请稍后再试")
                if len(inbox) >= INVITATION_LIMIT:
                    raise HTTPException(429, "该用户的邀请收件箱暂时已满")
                invitation = {
                    "id": str(uuid4()), "code": room["code"], "room_id": room.get("id"),
                    "inviter_id": str(user.id), "inviter_name": user.nickname or user.username, "status": "pending",
                    "expires_at": time() + INVITATION_TTL,
                }
                pipe.multi()
                pipe.set(inbox_key, json.dumps([invitation, *inbox]), ex=INVITATION_TTL)
                pipe.incr(rate_key).expire(rate_key, 60, nx=True)
                await pipe.execute()
                return _invitation_view(invitation)
            except WatchError:
                continue
    raise HTTPException(409, "邀请状态正在更新，请重试")


@router.post("/invitations/{invitation_id}/{decision}")
async def respond_invitation(
    invitation_id: UUID,
    decision: Literal["accept", "reject"],
    user: User = Depends(get_current_user),
):
    inbox_key = _inbox_key(user.id)
    status = "accepted" if decision == "accept" else "rejected"
    for _ in range(5):
        async with _redis().pipeline() as pipe:
            try:
                await pipe.watch(inbox_key)
                inbox = _read_inbox(await pipe.get(inbox_key))
                invitation = next((item for item in inbox if item["id"] == str(invitation_id)), None)
                if invitation is None:
                    raise HTTPException(404, "邀请不存在或已过期")
                if invitation["status"] not in {"pending", status}:
                    raise HTTPException(409, "该邀请已处理")
                if decision == "reject":
                    if invitation["status"] == "pending":
                        invitation["status"] = status
                        pipe.multi()
                        pipe.set(inbox_key, json.dumps(inbox), keepttl=True)
                        await pipe.execute()
                    return {"ok": True}

                room_key = _key(invitation["code"])
                await pipe.watch(room_key)
                room = _read(await pipe.get(room_key))
                if not _invitation_matches_room(invitation, room):
                    raise HTTPException(409, "邀请方已离开牌桌")
                if invitation["status"] == "accepted" and _seat(room, str(user.id)) is None:
                    raise HTTPException(409, "该邀请已使用")
                game = DouDizhuGame.from_dict(room["game"]) if room["game"] else None
                seat, game, joined = _join(room, game, str(user.id), user.nickname or user.username, user.avatar_url)
                invitation["status"] = status
                pipe.multi()
                if joined:
                    room["revision"] += 1
                    pipe.set(room_key, json.dumps(room), ex=ROOM_TTL)
                pipe.set(inbox_key, json.dumps(inbox), keepttl=True)
                await pipe.execute()
                return _snapshot(room, seat, game)
            except WatchError:
                continue
    raise HTTPException(409, "邀请状态正在更新，请重试")


@router.get("/interactions/presets")
async def interaction_presets():
    return {"items": [{"id": key, "kind": kind, "text": text}
                      for key, (kind, text) in INTERACTION_PRESETS.items()]}


@router.post("/rooms/{code}/interactions")
async def interact(
    code: str,
    payload: InteractionPayload,
    user: User = Depends(get_current_user),
):
    preset = INTERACTION_PRESETS.get(payload.preset)
    if preset is None or preset[0] != payload.kind:
        raise HTTPException(400, "请选择有效的预置互动")

    def apply(room, game):
        seat = _seat(room, str(user.id))
        if seat is None:
            raise HTTPException(404, "您尚未在此牌桌入座")
        if room["closed"] or len(room["players"]) < 2:
            raise HTTPException(409, "当前牌桌无法互动")
        target = payload.target_seat
        if (target is None and payload.kind != "chat") or (
            target is not None and (target == seat or target >= len(room["players"]))
        ):
            raise HTTPException(400, "请选择其他真人玩家作为互动对象")
        now = time()
        if payload.kind == "nudge":
            if game is None or game.phase not in {"bidding", "playing"} or game.turn != target:
                raise HTTPException(409, "只能催促当前回合的玩家")
            if now - room.get("turn_started_at", now) < NUDGE_IDLE_SECONDS:
                raise HTTPException(409, "请给当前玩家一些思考时间")
        cooldowns = room.setdefault("interaction_cooldowns", {})
        if now - cooldowns.get(str(user.id), 0) < INTERACTION_COOLDOWN:
            raise HTTPException(429, "互动太频繁，请稍后再试")
        cooldowns[str(user.id)] = now
        event = {"id": str(uuid4()), "kind": payload.kind, "text": preset[1], "from_seat": seat,
                 "target_seat": target, "at": _iso(now)}
        room["interactions"] = [*room.get("interactions", [])[-23:], event]
        return seat, game, True

    return await _update(code, apply, bump_revision=False)


@router.post("/rooms/{code}/action")
async def room_action(code: str, payload: RoomAction, request: Request,
                      user: User | None = Depends(get_current_user_optional)):
    identity, _ = _identity(request, user)

    def apply(room, game):
        seat = _seat(room, identity)
        if seat is None:
            raise HTTPException(404, "您尚未在此牌桌入座")
        if room["closed"]:
            return seat, game, False
        if payload.action == "leave":
            if seat == 0 or game is not None:
                room["closed"] = True
            else:
                room["players"].pop(seat)
                room.pop("interactions", None)
                room.get("interaction_cooldowns", {}).pop(identity, None)
            return seat, game, True
        if room["revision"] != payload.revision:
            raise HTTPException(409, "牌桌状态已更新，请重试")
        if game is None:
            raise HTTPException(409, "请等待所有玩家入座")
        try:
            if payload.action == "restart":
                if seat != 0 or game.phase != "finished":
                    raise HTTPException(403, "本局结束后可由房主再开一局")
                game.restart()
            elif payload.action == "bid":
                game.bid(seat, payload.bid)
            elif payload.action == "pass":
                game.pass_turn(seat)
            elif payload.action == "play":
                if any(card < 0 or card >= len(DECK) for card in payload.cards):
                    raise DouDizhuError("所选牌无效")
                game.play(seat, [DECK[card] for card in payload.cards])
        except DouDizhuError as error:
            raise HTTPException(400, str(error)) from error
        _advance(room, game)
        return seat, game, True

    return await _update(code, apply)
