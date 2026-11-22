"""回合制棋类对战：邀请制、服务端权威状态机、赛季战绩。

三款棋类共用同一套房间 / 走子 / 结算外壳，只通过 game_rules.RULES 分发规则。
状态一律放 PostgreSQL（board_state JSONB），不放进程内存——默认 2 个 uvicorn worker，
A/B 连到不同 worker 时也必须看到同一盘棋。
"""
import logging
import random
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.game_platform import BattleMatch, BattleMove, BattleSeasonStat
from app.models.system import Notification
from app.models.user import User
from app.routers.deps import get_current_user
from app.services.game_rules import RULES, RuleError

router = APIRouter(prefix="/battles", tags=["棋类对战"])
logger = logging.getLogger(__name__)
GAME_LABELS = {"gomoku": "五子棋", "xiangqi": "中国象棋", "tictactoe": "井字棋"}


def season_now() -> str:
    from app.routers.minigames import current_season_id
    return current_season_id()


class CreateBattle(BaseModel):
    game_code: str = Field(..., pattern="^(gomoku|xiangqi|tictactoe)$")
    invitee_id: uuid.UUID


class MovePayload(BaseModel):
    expected_seq: int = Field(..., ge=0)
    x: int
    y: int
    from_x: Optional[int] = None
    from_y: Optional[int] = None


class NudgePayload(BaseModel):
    """棋局互动：只接受预置文案的 id，避免被当成自由聊天/辱骂通道。"""
    preset_id: str = Field(..., max_length=32)


# 对手思考多久后才允许催；两次互动之间的最小间隔
NUDGE_IDLE_SECONDS = 10
NUDGE_COOLDOWN_SECONDS = 5

NUDGE_PRESETS: list[Dict[str, str]] = [
    {"id": "remind_1", "kind": "remind", "emoji": "⏰", "text": "该你落子啦～"},
    {"id": "remind_2", "kind": "remind", "emoji": "👀", "text": "我在等你这一步"},
    {"id": "remind_3", "kind": "remind", "emoji": "⌛", "text": "时间在流逝…"},
    {"id": "taunt_1", "kind": "taunt", "emoji": "🐢", "text": "你下得太慢了"},
    {"id": "taunt_2", "kind": "taunt", "emoji": "😴", "text": "等到我都快睡着了"},
    {"id": "taunt_3", "kind": "taunt", "emoji": "🍵", "text": "要不先喝口茶再想？"},
    {"id": "taunt_4", "kind": "taunt", "emoji": "🤏", "text": "就这步棋要想这么久？"},
    {"id": "taunt_5", "kind": "taunt", "emoji": "🐌", "text": "一步一步挪，蜗牛都到终点了"},
    {"id": "taunt_6", "kind": "taunt", "emoji": "🧠", "text": "想这么久，是在算怎么输得体面吗"},
    {"id": "taunt_7", "kind": "taunt", "emoji": "🍜", "text": "先吃碗面，回来接着想也不迟"},
    {"id": "taunt_8", "kind": "taunt", "emoji": "🎯", "text": "你的棋路我已经看穿了"},
    {"id": "taunt_9", "kind": "taunt", "emoji": "📉", "text": "别慌，反正结果都一样"},
    {"id": "taunt_10", "kind": "taunt", "emoji": "🏳️", "text": "要不直接认输，省点时间？"},
]
NUDGE_PRESET_MAP = {item["id"]: item for item in NUDGE_PRESETS}


def _parse_iso(value: Any) -> Optional[datetime]:
    """board_state 里的时间都是 ISO 字符串；解析失败一律当 None，不让脏数据阻断对局。"""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=utc_now().tzinfo)


def _last_activity_at(m: BattleMatch) -> Optional[datetime]:
    """最近一次“有效动作”的时间：上一手落子，否则开局时间，最后退到建房时间。"""
    state = m.board_state or {}
    return (
        _parse_iso((state.get("last_move") or {}).get("at"))
        or _parse_iso(state.get("started_at"))
        or m.created_at
    )


async def _push(uid: uuid.UUID, payload: Dict[str, Any]) -> None:
    """跨 worker 单播：ws_manager.send_to_users 内部已含 Redis publish。"""
    try:
        from app.services.ws_manager import ws_manager
        await ws_manager.send_to_users(payload, {str(uid)})
    except Exception:
        logger.exception("[Battle] WS 推送失败")


async def _stat(db: AsyncSession, season_id: str, uid: uuid.UUID) -> BattleSeasonStat:
    await db.execute(insert(BattleSeasonStat).values(season_id=season_id, user_id=uid)
                     .on_conflict_do_nothing(index_elements=[BattleSeasonStat.season_id, BattleSeasonStat.user_id]))
    return (await db.execute(
        select(BattleSeasonStat).where(
            BattleSeasonStat.season_id == season_id,
            BattleSeasonStat.user_id == uid,
        ).with_for_update()
    )).scalar_one()


async def _lock_match(db: AsyncSession, match_id: uuid.UUID) -> BattleMatch | None:
    return await db.scalar(select(BattleMatch).where(BattleMatch.id == match_id).with_for_update())


def _status(m: BattleMatch) -> str:
    return "expired" if m.status == "pending" and m.expires_at <= utc_now() else m.status


def _view(m: BattleMatch) -> Dict[str, Any]:
    state = m.board_state or {}
    last_move = state.get("last_move")
    last_nudge = state.get("last_nudge")
    last_activity = _last_activity_at(m)
    now = utc_now()
    return {
        "id": str(m.id), "game_code": m.game_code,
        "inviter_id": str(m.inviter_id), "invitee_id": str(m.invitee_id),
        "status": _status(m), "board_state": state,
        "first_player_id": state.get("first"),
        "red_id": state.get("red"),
        "black_id": state.get("black"),
        "move_seq": m.move_seq, "turn_user_id": str(m.turn_user_id) if m.turn_user_id else None,
        "winner_id": str(m.winner_id) if m.winner_id else None,
        "result": m.result,
        "created_at": m.created_at.isoformat() if m.created_at else None,
        "finished_at": m.finished_at.isoformat() if m.finished_at else None,
        # 落子高亮 + 互动提醒：客户端据此判断“谁刚走的”“对方思考多久了”
        "last_move": last_move,
        "last_move_at": last_activity.isoformat() if last_activity else None,
        "last_nudge": last_nudge,
        "server_now": now.isoformat(),
        "nudge_idle_seconds": NUDGE_IDLE_SECONDS,
        "nudge_cooldown_seconds": NUDGE_COOLDOWN_SECONDS,
    }


@router.get("/search-users")
async def search_users(
    q: str = Query("", max_length=64),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """邀请搜索：输入什么就搜什么，同时匹配可修改昵称与唯一 ID。"""
    term = q.strip()
    if len(term) < 1:
        return {"items": []}
    pattern = f"%{term}%"
    rows = (await db.execute(
        select(User.id, User.username, User.nickname, User.avatar_url)
        .where(
            User.status == "active",
            User.id != user.id,
            or_(User.username.ilike(pattern), User.nickname.ilike(pattern)),
        )
        .limit(20)
    )).all()
    online = {}
    try:
        from app.core.database import get_redis
        redis = get_redis()
        if redis:
            for uid, *_ in rows:
                online[str(uid)] = bool(await redis.exists(f"online:user:{uid}"))
    except Exception:
        pass
    return {"items": [{
        "user_id": str(uid), "username": un, "nickname": nn or un,
        "avatar_url": av or "", "online": online.get(str(uid), False),
    } for uid, un, nn, av in rows]}


@router.post("")
async def create_battle(
    req: CreateBattle,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if req.invitee_id == user.id:
        raise HTTPException(status_code=400, detail="不能邀请自己对战")
    target = (await db.execute(
        select(User).where(User.id == req.invitee_id, User.status == "active")
    )).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="被邀请用户不存在")
    pair = ":".join(sorted((str(user.id), str(req.invitee_id))))
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"battle-invite:{req.game_code}:{pair}"},
    )
    dup = await db.scalar(
        select(BattleMatch.id).where(
            BattleMatch.status == "pending",
            BattleMatch.expires_at > utc_now(),
            BattleMatch.game_code == req.game_code,
            or_(
                (BattleMatch.inviter_id == user.id) & (BattleMatch.invitee_id == req.invitee_id),
                (BattleMatch.inviter_id == req.invitee_id) & (BattleMatch.invitee_id == user.id),
            ),
        )
    )
    if dup:
        raise HTTPException(status_code=409, detail="你们之间已有一场待接受的对局")

    m = BattleMatch(
        id=uuid.uuid4(), game_code=req.game_code,
        inviter_id=user.id, invitee_id=req.invitee_id,
        status="pending", board_state={}, move_seq=0,
        expires_at=utc_now() + timedelta(minutes=10),
    )
    db.add(m)
    db.add(Notification(
        receiver_id=req.invitee_id, sender_id=user.id,
        action_type="game_invite", target_id=m.id,
        brief=f"@{user.nickname or user.username} 邀请你下{GAME_LABELS.get(req.game_code, '棋')}",
    ))
    await db.commit()
    await _push(req.invitee_id, {
        "type": "game_invite", "match_id": str(m.id),
        "game_code": m.game_code, "from": user.nickname or user.username,
    })
    return {"ok": True, "match_id": str(m.id)}


@router.get("/me")
async def my_battles(
    active_match_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    visible = or_(
        (BattleMatch.inviter_id == user.id) & BattleMatch.inviter_hidden_at.is_(None),
        (BattleMatch.invitee_id == user.id) & BattleMatch.invitee_hidden_at.is_(None),
    )
    rows = (await db.execute(
        select(BattleMatch).where(visible).order_by(BattleMatch.created_at.desc()).limit(30)
    )).scalars().all()
    uids = {r.inviter_id for r in rows} | {r.invitee_id for r in rows}
    names = {}
    if uids:
        for uid, un, nn in (await db.execute(
            select(User.id, User.username, User.nickname).where(User.id.in_(uids))
        )).all():
            names[uid] = nn or un
    items = [{**_view(m), "inviter_name": names.get(m.inviter_id, ""),
              "invitee_name": names.get(m.invitee_id, "")} for m in rows]
    result = {"items": items}
    if active_match_id:
        active = next((item for item in items if item["id"] == str(active_match_id)), None)
        if active is None:
            match = await db.scalar(select(BattleMatch).where(visible, BattleMatch.id == active_match_id))
            active = _view(match) if match else None
        result["active"] = active
    return result


@router.get("/nudge-presets")
async def nudge_presets(
    user: User = Depends(get_current_user),
):
    """棋局互动预置文案：提醒 / 嘲讽各若干条，前端按 kind 分组展示。

    必须声明在 /{match_id} 之前，否则会被当成 UUID 解析而 422。
    """
    return {
        "idle_seconds": NUDGE_IDLE_SECONDS,
        "cooldown_seconds": NUDGE_COOLDOWN_SECONDS,
        "items": NUDGE_PRESETS,
    }


@router.get("/{match_id}")
async def get_battle(
    match_id: uuid.UUID,
    include_moves: bool = True,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """拉取对局快照，可选返回截至快照序号的走子记录。"""
    m = await db.get(BattleMatch, match_id)
    if not m:
        raise HTTPException(status_code=404, detail="对局不存在")
    if user.id not in (m.inviter_id, m.invitee_id):
        raise HTTPException(status_code=403, detail="无权查看该对局")
    hidden_at = m.inviter_hidden_at if user.id == m.inviter_id else m.invitee_hidden_at
    if hidden_at:
        raise HTTPException(status_code=404, detail="对局不存在")
    view = _view(m)
    if not include_moves:
        return view
    moves = (await db.execute(
        select(BattleMove).where(BattleMove.match_id == match_id, BattleMove.seq <= m.move_seq)
        .order_by(BattleMove.seq)
    )).scalars().all()
    return {**view, "moves": [{"seq": x.seq, "actor_id": str(x.actor_id),
                              "payload": x.payload} for x in moves]}


@router.post("/{match_id}/accept")
async def accept_battle(
    match_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _lock_match(db, match_id)
    if not m or m.invitee_id != user.id:
        raise HTTPException(status_code=404, detail="邀请不存在")
    if m.status != "pending":
        raise HTTPException(status_code=400, detail="该邀请已处理")
    if m.expires_at <= utc_now():
        m.status = "expired"
        await db.commit()
        raise HTTPException(status_code=400, detail="邀请已过期")
    rules = RULES[m.game_code]
    # 随机先手：不再固定由邀请方开局，避免被邀请方每次都干等
    first = m.inviter_id if random.random() < 0.5 else m.invitee_id
    second = m.invitee_id if first == m.inviter_id else m.inviter_id

    if m.game_code == "xiangqi":
        # 象棋：阵营(红/黑)独立随机分配，与先手解耦。
        # 服务端 cells 始终用绝对坐标（红在下 y=7..9、黑在上 y=0..2），
        # 由前端按玩家阵营做 180° 视角翻转，保证"自己一侧永远在下方"。
        red = m.inviter_id if random.random() < 0.5 else m.invitee_id
        black = m.invitee_id if red == m.inviter_id else m.inviter_id
        state = dict(rules.initial(str(red), str(black)))
        state["turn"] = str(first)          # 允许黑方先手，回合判定只看 turn
    else:
        # 五子棋 / 井字棋：先手方即黑(X)，棋盘对称无需翻转
        state = dict(rules.initial(str(first), str(second)))

    m.board_state = {
        **state,
        "first": str(first),
        # 开局时间：还没有任何落子时，用它计算“对方思考了多久”
        "started_at": utc_now().isoformat(),
    }
    m.status = "playing"
    m.turn_user_id = first
    m.move_seq = 0
    await db.commit()
    await _push(m.inviter_id, {"type": "game_state", "match_id": str(m.id), **_view(m)})
    return {"ok": True, **_view(m)}


@router.post("/{match_id}/decline")
async def decline_battle(
    match_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _lock_match(db, match_id)
    if not m or m.invitee_id != user.id or _status(m) != "pending":
        raise HTTPException(status_code=400, detail="邀请不可拒绝")
    m.status = "declined"
    await db.commit()
    await _push(m.inviter_id, {"type": "game_decline", "match_id": str(m.id)})
    return {"ok": True}


@router.post("/{match_id}/cancel")
async def cancel_battle(
    match_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _lock_match(db, match_id)
    if not m or m.inviter_id != user.id or _status(m) != "pending":
        raise HTTPException(status_code=400, detail="邀请不可取消")
    m.status = "cancelled"
    await db.commit()
    return {"ok": True}


async def _finish(db: AsyncSession, m: BattleMatch, winner_id, result: str) -> None:
    """同一事务内写结果 + 双方赛季战绩，以 match_id 幂等。"""
    if m.status == "finished":
        return
    sid = season_now()
    m.status = "finished"
    m.winner_id = winner_id
    m.result = result
    m.finished_at = utc_now()
    m.turn_user_id = None
    m.board_state = {**m.board_state, "turn": None, "result": result,
                     "winner": str(winner_id) if winner_id else None}
    # 固定战绩行的加锁顺序，避免交叉结算时互相等待。
    for uid in sorted((m.inviter_id, m.invitee_id)):
        st = await _stat(db, sid, uid)
        if result == "draw":
            st.draws += 1
            st.current_streak = 0          # 和棋中断连胜（已确认）
        elif uid == winner_id:
            st.wins += 1
            st.current_streak += 1
            st.best_streak = max(st.best_streak, st.current_streak)
        else:
            st.losses += 1                 # 认输计负（已确认）
            st.current_streak = 0


@router.post("/{match_id}/move")
async def make_move(
    match_id: uuid.UUID,
    payload: MovePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _lock_match(db, match_id)
    if not m:
        raise HTTPException(status_code=404, detail="对局不存在")
    if user.id not in (m.inviter_id, m.invitee_id):
        raise HTTPException(status_code=403, detail="你不是对局参与者")
    if m.status != "playing":
        raise HTTPException(status_code=400, detail="对局已结束或尚未开始")
    if payload.expected_seq != m.move_seq:
        raise HTTPException(status_code=409, detail="棋局已变化，请刷新最新状态")

    rules = RULES[m.game_code]
    state = dict(m.board_state or {})
    move = {
        "x": payload.x, "y": payload.y,
        "from_x": payload.from_x, "from_y": payload.from_y,
    }
    try:
        new_state = rules.apply(state, str(user.id), move)
    except RuleError as e:
        raise HTTPException(status_code=400, detail=str(e))

    seq = m.move_seq + 1
    # last_move 是双方“最近一步高亮”的唯一数据源：
    # 含起点（象棋）、落点、执行者与时间，客户端按 actor_id 判断是谁的落子。
    m.board_state = {
        **state,
        **new_state,
        "last_move": {
            "seq": seq,
            "x": payload.x,
            "y": payload.y,
            "from_x": payload.from_x,
            "from_y": payload.from_y,
            "actor_id": str(user.id),
            "at": utc_now().isoformat(),
        },
    }
    m.move_seq = seq
    m.turn_user_id = uuid.UUID(new_state["turn"]) if new_state.get("turn") else None
    db.add(BattleMove(match_id=m.id, seq=seq, actor_id=user.id, payload=move))

    if new_state.get("result"):
        if new_state["result"] == "win":
            await _finish(db, m, uuid.UUID(new_state["winner"]), "win")
        else:
            await _finish(db, m, None, "draw")
    await db.commit()
    view = _view(m)
    for uid in (m.inviter_id, m.invitee_id):
        await _push(uid, {"type": "game_state", "match_id": str(m.id), **view})
    if m.status == "finished":
        for uid in (m.inviter_id, m.invitee_id):
            await _push(uid, {"type": "game_end", "match_id": str(m.id),
                              "winner_id": str(m.winner_id) if m.winner_id else None,
                              "result": m.result})
    return {"ok": True, "seq": seq, **view}


@router.post("/{match_id}/resign")
async def resign_battle(
    match_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    m = await _lock_match(db, match_id)
    if not m or user.id not in (m.inviter_id, m.invitee_id):
        raise HTTPException(status_code=403, detail="无权操作")
    if m.status != "playing":
        raise HTTPException(status_code=400, detail="对局已结束")
    winner = m.invitee_id if user.id == m.inviter_id else m.inviter_id
    await _finish(db, m, winner, "resign")
    await db.commit()
    view = _view(m)
    for uid in (m.inviter_id, m.invitee_id):
        await _push(uid, {"type": "game_end", "match_id": str(m.id), **view})
    return {"ok": True, **view}


@router.post("/{match_id}/nudge")
async def send_battle_nudge(
    match_id: uuid.UUID,
    payload: NudgePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """催促对手：只有“等对方落子”的一方能发，对方思考满 10 秒才允许，5 秒冷却。

    文案由服务端预置（NUDGE_PRESETS），不接受自由文本；结果写进 board_state.last_nudge
    并同时推给双方，因此离线/漏帧时靠轮询也能补到。
    """
    m = await _lock_match(db, match_id)
    if not m:
        raise HTTPException(status_code=404, detail="对局不存在")
    if user.id not in (m.inviter_id, m.invitee_id):
        raise HTTPException(status_code=403, detail="你不是对局参与者")
    if m.status != "playing":
        raise HTTPException(status_code=400, detail="对局已结束或尚未开始")
    if m.turn_user_id == user.id:
        raise HTTPException(status_code=400, detail="已经轮到你落子了，先下棋吧")

    preset = NUDGE_PRESET_MAP.get(payload.preset_id)
    if not preset:
        raise HTTPException(status_code=400, detail="未知的互动文案")

    now = utc_now()
    last_activity = _last_activity_at(m)
    idle = (now - last_activity).total_seconds() if last_activity else 0
    if idle < NUDGE_IDLE_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=f"对方才思考 {max(0, int(idle))} 秒，满 {NUDGE_IDLE_SECONDS} 秒后才能提醒",
        )

    state = dict(m.board_state or {})
    prev = state.get("last_nudge") or {}
    if str(prev.get("from_id") or "") == str(user.id):
        prev_at = _parse_iso(prev.get("at"))
        if prev_at:
            wait = NUDGE_COOLDOWN_SECONDS - (now - prev_at).total_seconds()
            if wait > 0:
                raise HTTPException(status_code=400, detail=f"刚刚提醒过了，{int(wait) + 1} 秒后再试")

    nudge = {
        "preset_id": preset["id"],
        "kind": preset["kind"],
        "emoji": preset["emoji"],
        "text": preset["text"],
        "from_id": str(user.id),
        "from_name": user.nickname or user.username,
        "at": now.isoformat(),
    }
    # 写进 board_state：双方下次轮询/刷新都能看到同一条互动
    m.board_state = {**state, "last_nudge": nudge}
    await db.commit()

    frame = {"type": "battle_nudge", "match_id": str(m.id), "nudge": nudge, **nudge}
    for uid in (m.inviter_id, m.invitee_id):
        await _push(uid, frame)
    return {
        "ok": True,
        "nudge": nudge,
        "server_now": now.isoformat(),
        "cooldown_seconds": NUDGE_COOLDOWN_SECONDS,
    }


@router.delete("/{match_id}")
async def delete_battle(
    match_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """从当前用户的历史中隐藏对局。"""
    m = await _lock_match(db, match_id)
    if not m:
        raise HTTPException(status_code=404, detail="对局不存在")
    if user.id not in (m.inviter_id, m.invitee_id):
        raise HTTPException(status_code=403, detail="无权删除该对局")
    status = _status(m)
    if status == "playing":
        raise HTTPException(status_code=400, detail="对局进行中，请先认输或等对局结束后再删除")
    if status == "pending":
        raise HTTPException(status_code=400, detail="请先取消或拒绝邀请")

    if user.id == m.inviter_id:
        m.inviter_hidden_at = m.inviter_hidden_at or utc_now()
    else:
        m.invitee_hidden_at = m.invitee_hidden_at or utc_now()
    await db.execute(
        Notification.__table__.delete().where(
            Notification.receiver_id == user.id,
            Notification.action_type == "game_invite",
            Notification.target_id == match_id,
        )
    )
    await db.commit()
    return {"ok": True, "id": str(match_id)}
