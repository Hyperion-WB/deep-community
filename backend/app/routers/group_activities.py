"""群互动：成语接龙（自动裁判）、每日求签、可视化群投票。

独立 router，避免改动群消息 HTTP / WS 双通道；机器人消息沿用 dice 端点的
「直接落库 + push_group_event 广播」范式，msg_type 使用 chain / fortune / poll。
"""
import json
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.chat import GroupMember, GroupMessage, GroupRoom
from app.models.group_activity import (
    DailyFortuneDraw, FeihuaGame, GroupPoll, GroupPollOption, GroupPollVote, IdiomChainGame,
)
from app.models.user import User
from app.routers.deps import get_current_active_user
from app.services import feihua as poetry
from app.services.fortune import draw_fortune
from app.services.idioms import (
    bot_next, check_answer, pick_start, tail_char, tail_sound, sound_hint,
    stats as idiom_stats,
)


# ---- 接龙裁判的幽默台词池（随机挑，避免每轮复读同一句）----
# 约定：每条都必须带 {who} 和 {word}，这样群消息和会话列表摘要
# 都能直接看到「谁接了什么」，不用点开工具箱才能知道进度。
HUMOR_OPEN = [
    "成语接龙开局！本裁判先甩一个「{w}」——请接与「{hint}」同音的字，同音不同字也算数，想蒙混过关可没门儿 😏",
    "叮！接龙局开了，我先手「{w}」。下一位请接「{hint}」这个音，别让冷场王上位啊～",
    "各位成语搭子集合 🎲 起手「{w}」，轮到接「{hint}」同音的字了，接不上的自觉交表情包！",
    "开盘啦！我压「{w}」，谁来接「{hint}」这个音？赢了没有奖杯，但有掌声 👏",
]

HUMOR_ACCEPT = [
    "{who} 一手「{word}」稳如老狗，差点把我难住 😤 我反手一个「{reply}」，下一位接「{hint}」音，敢来接招的举手！",
    "哟，{who} 这「{word}」接得有模有样嘛！我不客气了：「{reply}」。轮到「{hint}」同音，别装没看见哈～",
    "✅ {who} 接「{word}」，漂亮！我祭出「{reply}」应战，下一位请接「{hint}」音，接不上的请自觉鼓掌 👏",
    "{who}：「{word}」——好家伙，词库都替你捏把汗 🤏 我接「{reply}」，下一个「{hint}」音，谁来？",
    "{who} 用「{word}」稳稳落地，裁判给的满分不怕你骄傲 🏅 我接「{reply}」，继续「{hint}」音～",
]

HUMOR_WRONG = [
    "❌ {who} 端出「{word}」…… 裁判摇头：{reason}。先去观众席歇一轮，大家继续接「{sound}」音～",
    "哎呀 {who}，「{word}」这招没接住：{reason}。本轮罚你当啦啦队，读音还是「{sound}」，谁来救场？",
    "{who} 勇夺本轮「最勇敢翻车奖」🏅：{reason}。别走，继续接「{sound}」音还能翻身～",
    "{who} 的「{word}」被裁判无情退回：{reason}。场面一度尴尬，快接「{sound}」音救救孩子 🆘",
]

HUMOR_END = [
    "我……我居然接不上了！本局圆满收官，诸位都是成语界扛把子 🏆",
    "词库被你们掏空了，裁判认输，下课！🏳️",
    "接不上，真接不上，这届群友太狠了，我申请换个词库再战 😵",
]

HUMOR_MANUAL_END = [
    "本局被管理员按下了暂停键 ⏸️，江湖再见，下回再战！",
    "裁判被叫下班了，这局先记在账上，改天接着掰头 👋",
]


def _say(pool, **kw) -> str:
    """随机取一条台词；kw 作为值传入，不会被二次解析花括号。"""
    return random.choice(pool).format(**kw)


router = APIRouter(prefix="/chat/groups", tags=["群互动"])

_BJ = timezone(timedelta(hours=8))


def _today() -> str:
    return datetime.now(_BJ).date().isoformat()


async def _room(db: AsyncSession, room_id: UUID) -> GroupRoom:
    room = (await db.execute(select(GroupRoom).where(GroupRoom.id == room_id))).scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="群聊频道不存在")
    return room


async def _is_manager(db: AsyncSession, room_id: UUID, user: User) -> bool:
    if getattr(user, "role", "") in ("super_admin", "admin"):
        return True
    m = (await db.execute(
        select(GroupMember).where(GroupMember.room_id == room_id, GroupMember.user_id == user.id)
    )).scalar_one_or_none()
    return bool(m and m.role in ("owner", "admin"))


async def _bot_user_id(db: AsyncSession) -> Optional[UUID]:
    return (await db.execute(
        select(User.id).where(User.is_bot.is_(True)).limit(1)
    )).scalar_one_or_none()


async def _bot_say(db: AsyncSession, room: GroupRoom, msg_type: str, payload: dict, text: str) -> None:
    """发一条结构化机器人消息（普通文本无法伪造这种 msg_type）。"""
    from app.routers.chat import next_seq_id, push_group_event

    bot_id = await _bot_user_id(db)
    if not bot_id:
        return
    msg = GroupMessage(
        id=uuid.uuid4(), room_id=room.id, sender_id=bot_id,
        content=json.dumps({**payload, "text": text}, ensure_ascii=False),
        msg_type=msg_type, seq_id=await next_seq_id(),
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    bot = (await db.execute(select(User).where(User.id == bot_id))).scalar_one_or_none()
    frame = {
        "type": "group_msg", "room_id": str(room.id), "msg_id": str(msg.id),
        "sender_id": str(bot_id),
        "sender_username": bot.username if bot else "ai_companion",
        "sender_nickname": (bot.nickname if bot else None) or "接龙裁判",
        "sender_avatar": (bot.avatar_url if bot else None) or "",
        "sender_level": 1,
        "content": msg.content, "msg_type": msg_type,
        "seq_id": msg.seq_id, "is_recalled": False, "is_mention_all": False,
        "created_at": msg.created_at.isoformat() if msg.created_at else utc_now().isoformat(),
    }
    await push_group_event(db, room.id, room.is_public, frame)


# ==================== 成语接龙 ====================
CHAIN_DEFAULT_MINUTES = 10
CHAIN_MAX_MINUTES = 60
CHAIN_PRESET_MINUTES = (5, 10, 15, 30)


class ChainAnswer(BaseModel):
    word: str = Field(..., min_length=2, max_length=8)


class ChainStart(BaseModel):
    """开局时长（分钟）：默认 10，允许 1~60。到点自动结算，不无限接下去。"""
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=CHAIN_MAX_MINUTES)


async def _active_game(db: AsyncSession, room_id: UUID) -> Optional[IdiomChainGame]:
    return (await db.execute(
        select(IdiomChainGame).where(
            IdiomChainGame.room_id == room_id, IdiomChainGame.status == "playing"
        ).order_by(desc(IdiomChainGame.created_at)).limit(1)
    )).scalar_one_or_none()


def _parse_dt(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _chain_expires_at(game: IdiomChainGame) -> datetime:
    """本局截止时间；老局没有 expires_at 时按「开局时间 + 默认时长」兜底。"""
    st = dict(game.state_json or {})
    exp = _parse_dt(st.get("expires_at"))
    if exp is None:
        base = game.created_at or utc_now()
        if base.tzinfo is None:
            base = base.replace(tzinfo=timezone.utc)
        exp = base + timedelta(minutes=CHAIN_DEFAULT_MINUTES)
    return exp


def _chain_is_expired(game: IdiomChainGame) -> bool:
    return utc_now() >= _chain_expires_at(game)


def _chain_remaining_seconds(game: IdiomChainGame) -> int:
    return max(0, int((_chain_expires_at(game) - utc_now()).total_seconds()))


def _chain_rows(st: dict) -> List[dict]:
    """完整榜单：接对次数降序 → 答错少者优先 → 首次接对更早者优先。

    新局把累计分数放在 state["scores"]（entries 只保留最近 40 条），
    老局没有 scores 时从 entries 兜底聚合。
    """
    scores = st.get("scores")
    if not scores:
        agg: dict = {}
        for e in st.get("entries") or []:
            key = str(e.get("user_id") or e.get("user") or "")
            if not key:
                continue
            s = agg.setdefault(key, {"user": e.get("user") or "成员", "ok": 0, "wrong": 0, "first": None})
            ts = e.get("ts")
            if e.get("ok"):
                s["ok"] += 1
                if ts and (s["first"] is None or ts < s["first"]):
                    s["first"] = ts
            else:
                s["wrong"] += 1
        scores = agg

    rows = []
    for s in (scores or {}).values():
        ok = int(s.get("ok") or 0)
        if ok <= 0:
            continue
        rows.append({
            "user": s.get("user") or "成员",
            "ok": ok,
            "wrong": int(s.get("wrong") or 0),
            "first": s.get("first"),
        })
    rows.sort(key=lambda r: (-r["ok"], r["wrong"], r["first"] or 0))
    return rows


def _chain_end_text(rows: List[dict], st: dict, reason: str) -> str:
    label = {
        "timeout": "时间到",
        "manual": "管理员结束",
        "word_exhausted": "词库见底",
    }.get(reason, "已结束")
    minutes = st.get("duration_minutes") or CHAIN_DEFAULT_MINUTES
    lines = [f"🏁 本局接龙结束（{label} · 时长 {minutes} 分钟）"]
    if rows:
        medals = ("🥇", "🥈", "🥉")
        for i, r in enumerate(rows[:3]):
            lines.append(f"{medals[i]} {r['user']} · 接对 {r['ok']} 个")
        total_ok = sum(r["ok"] for r in rows)
        lines.append(f"共 {len(rows)} 人接对，累计 {total_ok} 个成语")
    else:
        lines.append("这局没人接对，下次再来 💪")
    lines.append("想再战一局？点卡片下方「接」重新开局。")
    return "\n".join(lines)


async def _push_chain_update(db: AsyncSession, room: GroupRoom, game: IdiomChainGame,
                             kind: str = "update") -> None:
    """轻量 WS 帧：只通知「这局的进度变了」，让打开着的面板立刻重拉状态。

    不发群消息、不落库、不计未读 —— 只是为了解决「别人接了，我这边还显示旧读音」。
    """
    from app.routers.chat import push_group_event

    st = dict(game.state_json or {})
    await push_group_event(db, room.id, room.is_public, {
        "type": "chain_update",
        "room_id": str(room.id),
        "kind": kind,
        "round": st.get("round"),
        "current_char": st.get("current_char"),
        "current_sound": st.get("current_sound"),
        "remaining_seconds": _chain_remaining_seconds(game) if game.status == "playing" else 0,
        "ended": game.status != "playing",
    })


async def _finish_chain(
    db: AsyncSession, room: GroupRoom, game: IdiomChainGame, reason: str = "timeout",
) -> Optional[List[dict]]:
    """结束一局并播报前三名。用条件 UPDATE 保证并发下只结算一次。"""
    from sqlalchemy import update as _update

    st = dict(game.state_json or {})
    rows = _chain_rows(st)
    ranking = rows[:3]
    stamp = utc_now()
    st["result"] = {
        "reason": reason,
        "ranking": ranking,
        "participants": len(rows),
        "ended_at": stamp.isoformat(),
        "duration_minutes": st.get("duration_minutes") or CHAIN_DEFAULT_MINUTES,
    }
    res = await db.execute(
        _update(IdiomChainGame)
        .where(IdiomChainGame.id == game.id, IdiomChainGame.status == "playing")
        .values(status="ended", ended_at=stamp, state_json=st)
    )
    await db.commit()
    if not res.rowcount:
        return None  # 已被别的请求结算过

    game.status = "ended"
    game.ended_at = stamp
    game.state_json = st
    await _bot_say(
        db, room, "chain",
        {"kind": "end", "reason": reason, "ranking": ranking,
         "participants": len(rows), "duration": st.get("duration_minutes")},
        _chain_end_text(rows, st, reason),
    )
    await _push_chain_update(db, room, game, "end")
    return ranking


@router.get("/{room_id}/idiom-chain/state")
async def chain_state(room_id: UUID, user: User = Depends(get_current_active_user),
                      db: AsyncSession = Depends(get_db)):
    can_manage = await _is_manager(db, room_id, user)
    meta = {
        "can_manage": can_manage,
        "presets": list(CHAIN_PRESET_MINUTES),
        "default_minutes": CHAIN_DEFAULT_MINUTES,
        "idiom_stats": idiom_stats(),
    }

    game = await _active_game(db, room_id)
    # 到点但定时任务还没扫到：这里兜底结算，保证用户一打开面板就看到战报
    if game and _chain_is_expired(game):
        room = await _room(db, room_id)
        await _finish_chain(db, room, game, "timeout")
        game = None

    if game:
        st = dict(game.state_json or {})
        return {"active": True, "game_id": str(game.id), "state": st,
                "remaining_seconds": _chain_remaining_seconds(game),
                "expires_at": _chain_expires_at(game).isoformat(), **meta}

    # 没有进行中的局：把最近一局战报带回面板，避免「结束即空白」
    last = (await db.execute(
        select(IdiomChainGame).where(
            IdiomChainGame.room_id == room_id, IdiomChainGame.status == "ended"
        ).order_by(desc(IdiomChainGame.ended_at)).limit(1)
    )).scalar_one_or_none()
    last_st = dict(last.state_json or {}) if last else None
    return {"active": False, "state": last_st,
            "result": (last_st or {}).get("result"), **meta}


@router.post("/{room_id}/idiom-chain/start")
async def chain_start(room_id: UUID, req: Optional[ChainStart] = None,
                      user: User = Depends(get_current_active_user),
                      db: AsyncSession = Depends(get_db)):
    room = await _room(db, room_id)

    minutes = int((req.duration_minutes if req else None) or CHAIN_DEFAULT_MINUTES)
    minutes = max(1, min(CHAIN_MAX_MINUTES, minutes))
    now = utc_now()
    expires_at = now + timedelta(minutes=minutes)

    old = await _active_game(db, room_id)
    if old:
        # 同一时间只允许一局：没到期就直接拒绝，到期的先结算掉
        if not _chain_is_expired(old):
            left = max(1, _chain_remaining_seconds(old) // 60)
            raise HTTPException(
                status_code=400,
                detail=f"本群已有一局接龙进行中（剩余约 {left} 分钟），先结束再开新局",
            )
        await _finish_chain(db, room, old, "timeout")

    first = pick_start()
    st = {
        "starter": first,
        # current_char 仅用于展示，current_sound 才是判定依据（同音接龙）
        "current_char": tail_char(first),
        "current_sound": tail_sound(first),
        "used": [first],
        "entries": [],
        "eliminated": [],
        "scores": {},
        "round": 1,
        "started_by": user.nickname or user.username,
        "started_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
        "duration_minutes": minutes,
    }
    game = IdiomChainGame(room_id=room_id, status="playing", state_json=st, created_by=user.id)
    db.add(game)
    await db.commit()
    await _bot_say(db, room, "chain",
                   {"kind": "start", "word": first, "next": tail_char(first),
                    "sound": tail_sound(first), "duration": minutes,
                    "expires_at": expires_at.isoformat()},
                   _say(HUMOR_OPEN, w=first, hint=sound_hint(first))
                   + f"\n⏱ 本局 {minutes} 分钟，到点自动结算并公布前三名。")
    await _push_chain_update(db, room, game, "start")
    return {"ok": True, "game_id": str(game.id), "state": st,
            "remaining_seconds": _chain_remaining_seconds(game),
            "idiom_stats": idiom_stats()}


@router.post("/{room_id}/idiom-chain/answer")
async def chain_answer(room_id: UUID, req: ChainAnswer,
                       user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    room = await _room(db, room_id)
    game = await _active_game(db, room_id)
    if not game:
        raise HTTPException(status_code=400, detail="当前没有进行中的接龙，先在工具箱里开局")
    if _chain_is_expired(game):
        await _finish_chain(db, room, game, "timeout")
        raise HTTPException(status_code=400, detail="本局已结束（时间到），最终排名已公布")

    st = dict(game.state_json or {})
    used: List[str] = list(st.get("used") or [])
    entries: List[dict] = list(st.get("entries") or [])
    eliminated: List[dict] = list(st.get("eliminated") or [])
    scores: dict = dict(st.get("scores") or {})
    who = user.nickname or user.username
    uid = str(user.id)

    # 旧局没有 current_sound 时回退到 current_char（服务内部会退化成严格同字）
    cur_sound = st.get("current_sound") or st.get("current_char", "")
    ok, reason = check_answer(req.word, cur_sound, used)
    word = req.word.strip()
    now_ts = utc_now().timestamp()

    s = dict(scores.get(uid) or {"user": who, "ok": 0, "wrong": 0, "first": None})
    s["user"] = who
    if ok:
        s["ok"] = int(s.get("ok") or 0) + 1
        if s.get("first") is None:
            s["first"] = now_ts
    else:
        s["wrong"] = int(s.get("wrong") or 0) + 1
    scores[uid] = s

    entries.append({"user_id": uid, "user": who, "word": word, "ok": ok,
                    "reason": reason, "ts": now_ts})

    ended_reason: Optional[str] = None
    exp_info: dict = {"gain": 0, "group_level": 0, "level_up": False, "daily_left": 0}
    if not ok:
        eliminated.append({"user": who, "word": word, "reason": reason})
    else:
        # 接龙成功：+5 群经验（受每日群经验上限约束）
        _member = (await db.execute(
            select(GroupMember).where(
                GroupMember.room_id == room_id, GroupMember.user_id == user.id,
            )
        )).scalar_one_or_none()
        if _member:
            from app.routers.chat import award_group_exp_flat
            exp_info = await award_group_exp_flat(db, _member, 5)
        used.append(word)
        st["current_char"] = tail_char(word)
        st["current_sound"] = tail_sound(word)
        reply = bot_next(st["current_sound"], used)
        if reply:
            used.append(reply)
            st["current_char"] = tail_char(reply)
            st["current_sound"] = tail_sound(reply)
        else:
            # 词库被接空：立即结算
            ended_reason = "word_exhausted"

    st["used"] = used
    st["entries"] = entries[-40:]
    st["eliminated"] = eliminated[-20:]
    st["scores"] = scores
    st["round"] = int(st.get("round") or 1) + 1
    game.state_json = st
    await db.commit()

    if ended_reason:
        await _finish_chain(db, room, game, ended_reason)
    else:
        # 别人接着答题时，把最新读音推给所有打开面板的人（否则会拿旧读音去接）
        await _push_chain_update(db, room, game, "update")

    return {"ok": ok, "reason": reason, "state": st, "ended": bool(ended_reason),
            "result": (st.get("result") or None), "idiom_stats": idiom_stats(),
            # 本次实得群经验（0 表示今日已达上限），前端据此提示而不是静默
            "exp_gained": int(exp_info.get("gain") or 0),
            "group_level": int(exp_info.get("group_level") or 0),
            "level_up": bool(exp_info.get("level_up")),
            "daily_exp_left": int(exp_info.get("daily_left") or 0)}


@router.post("/{room_id}/idiom-chain/end")
async def chain_end(room_id: UUID, user: User = Depends(get_current_active_user),
                    db: AsyncSession = Depends(get_db)):
    if not await _is_manager(db, room_id, user):
        raise HTTPException(status_code=403, detail="仅群主或管理员可结束接龙")
    game = await _active_game(db, room_id)
    if not game:
        return {"ok": True, "already": True}
    room = await _room(db, room_id)
    await _finish_chain(db, room, game, "manual")
    return {"ok": True}


async def auto_end_expired_chains(db: AsyncSession) -> int:
    """定时任务入口：把所有到点的接龙结算并播报前三名。

    不依赖有人答题——没人说话时也会在到点后 30 秒内出结果。
    """
    games = (await db.execute(
        select(IdiomChainGame).where(IdiomChainGame.status == "playing")
    )).scalars().all()
    ended = 0
    for g in games:
        if not _chain_is_expired(g):
            continue
        room = (await db.execute(
            select(GroupRoom).where(GroupRoom.id == g.room_id)
        )).scalar_one_or_none()
        if room is None:
            g.status = "ended"
            g.ended_at = utc_now()
            await db.commit()
            continue
        if await _finish_chain(db, room, g, "timeout"):
            ended += 1
    return ended


# ==================== 飞花令 ====================
FEIHUA_DEFAULT_MINUTES = 10
FEIHUA_MAX_MINUTES = 60
FEIHUA_PRESET_MINUTES = (5, 10, 15, 30)


class FeihuaStart(BaseModel):
    """开局：时长 + 可选自选令字 + 校验模式（auto 时按词库覆盖自动选）。"""
    duration_minutes: Optional[int] = Field(default=None, ge=1, le=FEIHUA_MAX_MINUTES)
    flag: Optional[str] = Field(default=None, max_length=2)
    flag_mode: Optional[str] = Field(default=None, pattern="^(auto|strict|loose)$")


class FeihuaAnswer(BaseModel):
    verse: str = Field(..., min_length=1, max_length=40)


def _feihua_expires_at(game: FeihuaGame) -> datetime:
    st = dict(game.state_json or {})
    exp = _parse_dt(st.get("expires_at"))
    if exp is None:
        base = game.created_at or utc_now()
        if base.tzinfo is None:
            base = base.replace(tzinfo=timezone.utc)
        exp = base + timedelta(minutes=FEIHUA_DEFAULT_MINUTES)
    return exp


def _feihua_is_expired(game: FeihuaGame) -> bool:
    return utc_now() >= _feihua_expires_at(game)


def _feihua_remaining_seconds(game: FeihuaGame) -> int:
    return max(0, int((_feihua_expires_at(game) - utc_now()).total_seconds()))


async def _active_feihua(db: AsyncSession, room_id: UUID) -> Optional[FeihuaGame]:
    return (await db.execute(
        select(FeihuaGame).where(
            FeihuaGame.room_id == room_id, FeihuaGame.status == "playing"
        ).order_by(desc(FeihuaGame.created_at)).limit(1)
    )).scalar_one_or_none()


def _feihua_rows(st: dict) -> List[dict]:
    """答对句数排行：先比答对，再比答错少，最后比谁先答对。"""
    scores = st.get("scores") or {}
    rows = []
    for s in scores.values():
        ok = int(s.get("ok") or 0)
        if ok <= 0:
            continue
        rows.append({
            "user": s.get("user") or "成员",
            "ok": ok,
            "wrong": int(s.get("wrong") or 0),
            "first": s.get("first"),
        })
    rows.sort(key=lambda r: (-r["ok"], r["wrong"], r["first"] or 0))
    return rows


def _feihua_end_text(rows: List[dict], st: dict, reason: str) -> str:
    label = {"timeout": "时间到", "manual": "管理员结束"}.get(reason, "已结束")
    minutes = st.get("duration_minutes") or FEIHUA_DEFAULT_MINUTES
    flag = st.get("flag") or ""
    lines = [f"🏁 本局飞花令结束（{label} · 令字「{flag}」 · {minutes} 分钟）"]
    if rows:
        medals = ("🥇", "🥈", "🥉")
        for i, r in enumerate(rows[:3]):
            lines.append(f"{medals[i]} {r['user']} · 答对 {r['ok']} 句")
        total = sum(r["ok"] for r in rows)
        lines.append(f"共 {len(rows)} 人参与，累计 {total} 句")
        best = next((e for e in reversed(st.get("entries") or []) if e.get("ok")), None)
        if best and best.get("verse"):
            tail = f" —— {best['info']}" if best.get("info") else ""
            lines.append(f"本场金句：{best['verse']}{tail}")
    else:
        lines.append("这局没人接上，下回再来 🍵")
    return "\n".join(lines)


async def _push_feihua_update(db: AsyncSession, room: GroupRoom, game: FeihuaGame,
                              kind: str = "update") -> None:
    """轻量 WS 帧：面板收到就重拉状态，不落库、不计未读。"""
    from app.routers.chat import push_group_event

    st = dict(game.state_json or {})
    await push_group_event(db, room.id, room.is_public, {
        "type": "feihua_update",
        "room_id": str(room.id),
        "kind": kind,
        "flag": st.get("flag"),
        "round": st.get("round"),
        "answered": sum(1 for e in (st.get("entries") or []) if e.get("ok")),
        "remaining_seconds": _feihua_remaining_seconds(game) if game.status == "playing" else 0,
        "ended": game.status != "playing",
    })


async def _finish_feihua(db: AsyncSession, room: GroupRoom, game: FeihuaGame,
                         reason: str = "timeout") -> Optional[List[dict]]:
    """结算并播报前三名；条件 UPDATE 保证并发下只结算一次。"""
    from sqlalchemy import update as _update

    st = dict(game.state_json or {})
    rows = _feihua_rows(st)
    stamp = utc_now()
    st["result"] = {
        "reason": reason,
        "flag": st.get("flag"),
        "ranking": rows[:3],
        "participants": len(rows),
        "total_ok": sum(r["ok"] for r in rows),
        "ended_at": stamp.isoformat(),
        "duration_minutes": st.get("duration_minutes") or FEIHUA_DEFAULT_MINUTES,
    }
    res = await db.execute(
        _update(FeihuaGame)
        .where(FeihuaGame.id == game.id, FeihuaGame.status == "playing")
        .values(status="ended", ended_at=stamp, state_json=st)
    )
    await db.commit()
    if not res.rowcount:
        return None

    game.status = "ended"
    game.ended_at = stamp
    game.state_json = st
    await _bot_say(
        db, room, "feihua",
        {"kind": "end", "reason": reason, "flag": st.get("flag"),
         "ranking": rows[:3], "participants": len(rows),
         "duration": st.get("duration_minutes")},
        _feihua_end_text(rows, st, reason),
    )
    await _push_feihua_update(db, room, game, "end")
    return rows


async def _feihua_submit(db: AsyncSession, room: GroupRoom, game: FeihuaGame,
                         user: User, raw_verse: str) -> dict:
    """校验一句并计分。面板接口与「群内直接发诗句」共用这一条路径。"""
    st = dict(game.state_json or {})
    flag = st.get("flag") or ""
    used = list(st.get("used") or [])
    entries = list(st.get("entries") or [])
    scores = dict(st.get("scores") or {})
    who = user.nickname or user.username
    uid = str(user.id)
    now_ts = utc_now().timestamp()

    ok, reason, verse, info = poetry.validate(raw_verse, flag, st.get("flag_mode") or "auto")
    if ok and verse in used:
        ok, reason = False, "这句已经有人答过了"

    s = dict(scores.get(uid) or {"user": who, "ok": 0, "wrong": 0, "first": None})
    s["user"] = who
    if ok:
        s["ok"] = int(s.get("ok") or 0) + 1
        if s.get("first") is None:
            s["first"] = now_ts
    else:
        s["wrong"] = int(s.get("wrong") or 0) + 1
    scores[uid] = s

    entries.append({"user_id": uid, "user": who, "verse": verse, "info": info,
                    "ok": ok, "reason": reason, "ts": now_ts})

    exp_info: dict = {"gain": 0, "group_level": 0, "level_up": False, "daily_left": 0}
    if ok:
        used.append(verse)
        member = (await db.execute(
            select(GroupMember).where(
                GroupMember.room_id == room.id, GroupMember.user_id == user.id,
            )
        )).scalar_one_or_none()
        if member:
            from app.routers.chat import award_group_exp_flat
            exp_info = await award_group_exp_flat(db, member, 5)

    st["used"] = used
    st["entries"] = entries[-60:]
    st["scores"] = scores
    st["round"] = int(st.get("round") or 1) + 1
    game.state_json = st
    await db.commit()
    await _push_feihua_update(db, room, game, "update")

    # 降噪：答对/答错都不再往群里发卡片（与成语接龙一致，群记录里只留「开局」和「战报」两张），
    # 进度通过 WS feihua_update 推给打开着的面板，别人答对了面板里会实时刷新。
    return {"ok": ok, "reason": reason, "verse": verse, "info": info,
            "state": st, "ended": False, "result": st.get("result"),
            "exp_gained": int(exp_info.get("gain") or 0),
            "group_level": int(exp_info.get("group_level") or 0),
            "level_up": bool(exp_info.get("level_up")),
            "daily_exp_left": int(exp_info.get("daily_left") or 0)}


async def feihua_try_verse(db: AsyncSession, room: GroupRoom, user: User, text: str) -> Optional[dict]:
    """群内直接发诗句：只有「局进行中 + 消息含令字」才判定，普通聊天零影响。"""
    game = await _active_feihua(db, room.id)
    if not game:
        return None
    st = dict(game.state_json or {})
    flag = st.get("flag") or ""
    if not flag or flag not in poetry.normalize(text):
        return None
    if _feihua_is_expired(game):
        await _finish_feihua(db, room, game, "timeout")
        return None
    res = await _feihua_submit(db, room, game, user, text)
    # 群里不再发卡片（避免刷屏），但把「算不算、出的哪首」定向推给发送者本人
    try:
        from app.services.ws_manager import ws_manager
        await ws_manager.send_personal_message({
            "type": "feihua_self",
            "room_id": str(room.id),
            "ok": bool(res.get("ok")),
            "verse": res.get("verse"),
            "info": res.get("info"),
            "reason": res.get("reason"),
        }, str(user.id))
    except Exception:
        pass
    return res


@router.get("/{room_id}/feihua/state")
async def feihua_state(room_id: UUID, user: User = Depends(get_current_active_user),
                       db: AsyncSession = Depends(get_db)):
    can_manage = await _is_manager(db, room_id, user)
    meta = {
        "can_manage": can_manage,
        "presets": list(FEIHUA_PRESET_MINUTES),
        "default_minutes": FEIHUA_DEFAULT_MINUTES,
        "flags": poetry.available_flags(60),
        "poetry": poetry.stats(),
    }

    game = await _active_feihua(db, room_id)
    if game and _feihua_is_expired(game):
        room = await _room(db, room_id)
        await _finish_feihua(db, room, game, "timeout")
        game = None

    if game:
        st = dict(game.state_json or {})
        return {"active": True, "game_id": str(game.id), "state": st,
                "remaining_seconds": _feihua_remaining_seconds(game),
                "expires_at": _feihua_expires_at(game).isoformat(), **meta}

    last = (await db.execute(
        select(FeihuaGame).where(
            FeihuaGame.room_id == room_id, FeihuaGame.status == "ended"
        ).order_by(desc(FeihuaGame.ended_at)).limit(1)
    )).scalar_one_or_none()
    last_st = dict(last.state_json or {}) if last else None
    return {"active": False, "state": last_st,
            "result": (last_st or {}).get("result"), **meta}


@router.get("/{room_id}/feihua/flags")
async def feihua_flags(room_id: UUID, q: Optional[str] = None,
                       user: User = Depends(get_current_active_user)):
    """令字选择器：默认返回意象字，q 用来搜索任意字（含该字的可用句数）。"""
    if q:
        ch = poetry.normalize(q)[:1]
        if not ch:
            return {"flags": []}
        return {"flags": [{"flag": ch, "cnt": poetry.flag_count(ch)}]}
    return {"flags": poetry.available_flags(60)}


@router.post("/{room_id}/feihua/start")
async def feihua_start(room_id: UUID, req: Optional[FeihuaStart] = None,
                       user: User = Depends(get_current_active_user),
                       db: AsyncSession = Depends(get_db)):
    room = await _room(db, room_id)

    minutes = int((req.duration_minutes if req else None) or FEIHUA_DEFAULT_MINUTES)
    minutes = max(1, min(FEIHUA_MAX_MINUTES, minutes))

    flag = ((req.flag if req else None) or "").strip() or poetry.random_flag()
    if len(flag) != 1 or not ("\u4e00" <= flag <= "\u9fff"):
        raise HTTPException(status_code=400, detail="令字必须是单个汉字（如「月」「雪」）")

    requested_mode = (req.flag_mode if req else None) or "auto"
    mode = poetry.resolve_mode(flag, requested_mode)

    now = utc_now()
    expires_at = now + timedelta(minutes=minutes)

    old = await _active_feihua(db, room_id)
    if old:
        if not _feihua_is_expired(old):
            left = max(1, _feihua_remaining_seconds(old) // 60)
            raise HTTPException(
                status_code=400,
                detail=f"本群已有一局飞花令进行中（剩余约 {left} 分钟），先结束再开新局",
            )
        await _finish_feihua(db, room, old, "timeout")

    library_count = poetry.flag_count(flag)
    st = {
        "flag": flag,
        "flag_mode": mode,
        "duration_minutes": minutes,
        "starter": user.nickname or user.username,
        "started_by": user.nickname or user.username,
        "started_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
        "library_count": library_count,
        "used": [],
        "entries": [],
        "scores": {},
        "round": 1,
    }
    game = FeihuaGame(room_id=room_id, status="playing", flag=flag, state_json=st, created_by=user.id)
    db.add(game)
    await db.commit()

    hint = (
        f"（诗库 {library_count} 句可答）" if mode == "strict"
        else f"（自由模式：诗句含「{flag}」即可）"
    )
    await _bot_say(
        db, room, "feihua",
        {"kind": "start", "flag": flag, "mode": mode, "duration": minutes,
         "expires_at": expires_at.isoformat(), "library_count": library_count},
        f"🏮 飞花令开局！令字【{flag}】{hint}\n"
        f"说一句含「{flag}」的诗句，答对 +1 分（群经验 +5），同一句不能重复。\n"
        f"直接在群里发诗句也算，⏱ 本局 {minutes} 分钟，到点自动结算。",
    )
    await _push_feihua_update(db, room, game, "start")
    return {"ok": True, "game_id": str(game.id), "state": st,
            "remaining_seconds": _feihua_remaining_seconds(game),
            "poetry": poetry.stats()}


@router.post("/{room_id}/feihua/answer")
async def feihua_answer(room_id: UUID, req: FeihuaAnswer,
                        user: User = Depends(get_current_active_user),
                        db: AsyncSession = Depends(get_db)):
    room = await _room(db, room_id)
    game = await _active_feihua(db, room_id)
    if not game:
        raise HTTPException(status_code=400, detail="当前没有进行中的飞花令，先在工具箱里开局")
    if _feihua_is_expired(game):
        await _finish_feihua(db, room, game, "timeout")
        raise HTTPException(status_code=400, detail="本局已结束（时间到），最终排名已公布")

    res = await _feihua_submit(db, room, game, user, req.verse)
    if not res["ok"]:
        raise HTTPException(status_code=400, detail=res["reason"])
    return res


@router.post("/{room_id}/feihua/end")
async def feihua_end(room_id: UUID, user: User = Depends(get_current_active_user),
                     db: AsyncSession = Depends(get_db)):
    if not await _is_manager(db, room_id, user):
        raise HTTPException(status_code=403, detail="仅群主或管理员可结束飞花令")
    game = await _active_feihua(db, room_id)
    if not game:
        return {"ok": True, "already": True}
    room = await _room(db, room_id)
    await _finish_feihua(db, room, game, "manual")
    return {"ok": True}


async def auto_end_expired_feihua(db: AsyncSession) -> int:
    """定时任务入口：到点结算，不依赖有人答题。"""
    games = (await db.execute(
        select(FeihuaGame).where(FeihuaGame.status == "playing")
    )).scalars().all()
    ended = 0
    for g in games:
        if not _feihua_is_expired(g):
            continue
        room = (await db.execute(
            select(GroupRoom).where(GroupRoom.id == g.room_id)
        )).scalar_one_or_none()
        if room is None:
            g.status = "ended"
            g.ended_at = utc_now()
            await db.commit()
            continue
        if await _finish_feihua(db, room, g, "timeout"):
            ended += 1
    return ended


# ==================== 每日求签 ====================
FORTUNE_DAILY_LIMIT = 2
FORTUNE_GROUP_EXP = 2      # 每次求签的群经验（与接龙/飞花令共用每日经验上限）
POLL_VOTE_GROUP_EXP = 2    # 首次参与群投票的群经验


@router.get("/{room_id}/fortune/status")
async def fortune_status(room_id: UUID, user: User = Depends(get_current_active_user),
                         db: AsyncSession = Depends(get_db)):
    used = int((await db.scalar(
        select(func.count()).select_from(DailyFortuneDraw).where(
            DailyFortuneDraw.user_id == user.id, DailyFortuneDraw.draw_date == _today()
        )
    )) or 0)
    return {"used": used, "limit": FORTUNE_DAILY_LIMIT,
            "remaining": max(0, FORTUNE_DAILY_LIMIT - used)}


@router.post("/{room_id}/fortune")
async def draw_daily_fortune(room_id: UUID, user: User = Depends(get_current_active_user),
                             db: AsyncSession = Depends(get_db)):
    """每人每天限两次；结果由服务端决定，前端不能指定。"""
    day = _today()
    rows = (await db.execute(
        select(DailyFortuneDraw).where(
            DailyFortuneDraw.user_id == user.id, DailyFortuneDraw.draw_date == day
        )
    )).scalars().all()
    if len(rows) >= FORTUNE_DAILY_LIMIT:
        raise HTTPException(status_code=429, detail="今天已经求过两次签啦，明天再来～")
    seed = int(uuid.uuid4().int % (2 ** 31))
    result = draw_fortune(seed)
    draw = DailyFortuneDraw(
        id=uuid.uuid4(), user_id=user.id, draw_date=day,
        occurrence=len(rows) + 1, tier=result["tier"], result_json=result,
    )
    db.add(draw)
    # 求签也计入群经验：每天最多两次，避免刷分
    from app.routers.chat import award_group_exp_flat
    member = (await db.execute(
        select(GroupMember).where(GroupMember.room_id == room_id, GroupMember.user_id == user.id)
    )).scalar_one_or_none()
    exp_info = await award_group_exp_flat(db, member, FORTUNE_GROUP_EXP) if member else {
        "gain": 0, "group_level": 0, "level_up": False, "daily_left": 0,
    }
    await db.commit()
    return {**result, "remaining": FORTUNE_DAILY_LIMIT - len(rows) - 1,
            "date": day, "occurrence": draw.occurrence,
            "exp_gained": int(exp_info.get("gain") or 0),
            "group_level": int(exp_info.get("group_level") or 0),
            "level_up": bool(exp_info.get("level_up")),
            "daily_exp_left": int(exp_info.get("daily_left") or 0)}


# ==================== 群投票 ====================
class PollCreate(BaseModel):
    title: str = Field(..., min_length=2, max_length=200)
    description: Optional[str] = Field(None, max_length=1000)
    options: List[str] = Field(..., min_length=2, max_length=12)
    is_multiple: bool = False
    is_anonymous: bool = False
    max_choices: int = Field(1, ge=1, le=12)
    duration_hours: int = Field(72, ge=1, le=24 * 30)


class PollVoteReq(BaseModel):
    option_ids: List[int] = Field(..., min_length=1, max_length=12)


def _expired(p: GroupPoll) -> bool:
    exp = p.expires_at
    if exp and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    return bool(p.closed_at or (exp and exp <= datetime.now(timezone.utc)))


async def _poll_result(db: AsyncSession, p: GroupPoll, user: User, detail: bool = False) -> dict:
    opts = (await db.execute(
        select(GroupPollOption).where(GroupPollOption.poll_id == p.id)
        .order_by(GroupPollOption.sort_order, GroupPollOption.id)
    )).scalars().all()
    voted = (await db.execute(
        select(GroupPollOption.id).join(GroupPollVote, GroupPollVote.option_id == GroupPollOption.id)
        .where(GroupPollVote.poll_id == p.id, GroupPollVote.user_id == user.id)
    )).scalars().all()
    total = sum(int(o.vote_count or 0) for o in opts)
    items = [{"id": o.id, "text": o.option_text, "votes": int(o.vote_count or 0),
              "percentage": round((int(o.vote_count or 0) / total * 100), 1) if total else 0.0,
              "voted": o.id in voted} for o in opts]
    out = {
        "id": str(p.id), "title": p.title, "description": p.description,
        "is_multiple": p.is_multiple, "is_anonymous": p.is_anonymous,
        "max_choices": p.max_choices,
        "expires_at": p.expires_at, "closed_at": p.closed_at,
        "is_expired": _expired(p), "total_votes": total,
        "has_voted": bool(voted), "options": items,
        "can_manage": await _is_manager(db, p.room_id, user),
    }
    if detail:
        votes = (await db.execute(
            select(GroupPollVote, User.username, User.nickname, GroupPollOption.option_text)
            .join(User, User.id == GroupPollVote.user_id)
            .join(GroupPollOption, GroupPollOption.id == GroupPollVote.option_id)
            .where(GroupPollVote.poll_id == p.id).order_by(GroupPollVote.created_at)
        )).all()
        out["details"] = [] if p.is_anonymous else [
            {"user": n or u, "option": t, "at": v.created_at} for v, u, n, t in votes
        ]
        if p.is_anonymous:
            out["details_note"] = "本投票为匿名投票，不展示投票人明细"
    return out


@router.post("/{room_id}/polls")
async def create_poll(room_id: UUID, req: PollCreate,
                      user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    await _room(db, room_id)
    if not await _is_manager(db, room_id, user):
        raise HTTPException(status_code=403, detail="仅群主或管理员可发起群投票")
    clean = [o.strip()[:200] for o in req.options if o.strip()]
    if len(clean) < 2:
        raise HTTPException(status_code=400, detail="至少需要两个有效选项")
    max_choices = req.max_choices if req.is_multiple else 1
    p = GroupPoll(
        id=uuid.uuid4(), room_id=room_id, creator_id=user.id,
        title=req.title.strip(), description=req.description,
        is_multiple=req.is_multiple, is_anonymous=req.is_anonymous,
        max_choices=max_choices,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=req.duration_hours),
    )
    db.add(p)
    await db.flush()
    for i, text in enumerate(clean):
        db.add(GroupPollOption(poll_id=p.id, option_text=text, sort_order=i))
    await db.commit()
    return {"ok": True, "id": str(p.id)}


@router.get("/{room_id}/polls")
async def list_polls(room_id: UUID, user: User = Depends(get_current_active_user),
                     db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(GroupPoll).where(GroupPoll.room_id == room_id)
        .order_by(desc(GroupPoll.created_at)).limit(30)
    )).scalars().all()
    return {"items": [await _poll_result(db, p, user) for p in rows]}


@router.get("/{room_id}/polls/{poll_id}")
async def poll_detail(room_id: UUID, poll_id: UUID,
                      user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    p = (await db.execute(
        select(GroupPoll).where(GroupPoll.id == poll_id, GroupPoll.room_id == room_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="投票不存在")
    return await _poll_result(db, p, user, detail=True)


@router.post("/{room_id}/polls/{poll_id}/vote")
async def vote_poll(room_id: UUID, poll_id: UUID, req: PollVoteReq,
                    user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    p = (await db.execute(
        select(GroupPoll).where(GroupPoll.id == poll_id, GroupPoll.room_id == room_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="投票不存在")
    if _expired(p):
        raise HTTPException(status_code=400, detail="投票已结束")
    if not p.is_multiple and len(req.option_ids) > 1:
        raise HTTPException(status_code=400, detail="该投票为单选")
    if len(req.option_ids) > int(p.max_choices or 1):
        raise HTTPException(status_code=400, detail=f"最多可选 {p.max_choices} 项")
    exists = (await db.scalar(
        select(func.count()).select_from(GroupPollVote).where(
            GroupPollVote.poll_id == poll_id, GroupPollVote.user_id == user.id
        )
    )) or 0
    if exists:
        raise HTTPException(status_code=409, detail="你已经投过票了")
    valid = (await db.execute(
        select(GroupPollOption.id).where(
            GroupPollOption.poll_id == poll_id, GroupPollOption.id.in_(req.option_ids)
        )
    )).scalars().all()
    if len(set(valid)) != len(set(req.option_ids)):
        raise HTTPException(status_code=400, detail="存在无效选项")
    for oid in set(req.option_ids):
        db.add(GroupPollVote(poll_id=poll_id, option_id=oid, user_id=user.id))
        await db.execute(
            GroupPollOption.__table__.update().where(GroupPollOption.id == oid)
            .values(vote_count=GroupPollOption.vote_count + 1)
        )
    # 首次参与投票 +2 群经验（一个投票只能领一次，改票不再重复加）
    from app.routers.chat import award_group_exp_flat
    member = (await db.execute(
        select(GroupMember).where(GroupMember.room_id == room_id, GroupMember.user_id == user.id)
    )).scalar_one_or_none()
    exp_info = await award_group_exp_flat(db, member, POLL_VOTE_GROUP_EXP) if member else {
        "gain": 0, "group_level": 0, "level_up": False, "daily_left": 0,
    }
    await db.commit()
    res = await _poll_result(db, p, user)
    res["exp_gained"] = int(exp_info.get("gain") or 0)
    res["group_level"] = int(exp_info.get("group_level") or 0)
    res["level_up"] = bool(exp_info.get("level_up"))
    res["daily_exp_left"] = int(exp_info.get("daily_left") or 0)
    return res


@router.post("/{room_id}/polls/{poll_id}/close")
async def close_poll(room_id: UUID, poll_id: UUID,
                     user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    p = (await db.execute(
        select(GroupPoll).where(GroupPoll.id == poll_id, GroupPoll.room_id == room_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="投票不存在")
    if not await _is_manager(db, room_id, user):
        raise HTTPException(status_code=403, detail="仅群主或管理员可结束投票")
    p.closed_at = utc_now()
    await db.commit()
    return {"ok": True}


@router.get("/{room_id}/polls/{poll_id}/report")
async def poll_report(room_id: UUID, poll_id: UUID,
                      user: User = Depends(get_current_active_user), db: AsyncSession = Depends(get_db)):
    """结束后自动生成的统计报告（未结束也能预览，标注进行中）。"""
    p = (await db.execute(
        select(GroupPoll).where(GroupPoll.id == poll_id, GroupPoll.room_id == room_id)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="投票不存在")
    res = await _poll_result(db, p, user, detail=True)
    ranked = sorted(res["options"], key=lambda o: o["votes"], reverse=True)
    top = ranked[0] if ranked else None
    return {
        "title": p.title, "status": "已结束" if res["is_expired"] else "进行中",
        "total_votes": res["total_votes"],
        "options_count": len(res["options"]),
        "winner": top["text"] if top and top["votes"] else None,
        "winner_votes": top["votes"] if top else 0,
        "winner_share": top["percentage"] if top else 0,
        "is_anonymous": p.is_anonymous,
        "ranking": ranked,
        "generated_at": utc_now(),
        "summary": (
            f"共 {res['total_votes']} 人次参与，"
            + (f"「{top['text']}」以 {top['votes']} 票（{top['percentage']}%）领先。" if top and top["votes"] else "暂无有效票数。")
        ),
    }
