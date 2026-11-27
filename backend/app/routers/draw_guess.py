from secrets import choice
from time import time_ns
from typing import Literal
from unicodedata import normalize
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import BigInteger, Column, ForeignKey, Index, delete, func, select
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import Base, get_db
from app.models.chat import GroupMember, GroupRoom
from app.models.user import User
from app.routers.deps import get_current_active_user
from app.routers.group_activities import _room
from app.services.sensitive_service import sensitive_filter

router = APIRouter(prefix="/chat/groups/{room_id}/draw-guess", tags=["群互动"])
_WORDS = (
    "雨伞", "雪人", "长颈鹿", "红绿灯", "自行车", "月亮", "风筝", "西瓜", "火山",
    "海豚", "章鱼", "螃蟹", "帐篷", "热气球", "望远镜", "闹钟", "灯塔", "书包",
    "大熊猫", "仙人掌", "积木", "滑板", "直升机", "生日蛋糕", "摩天轮", "机器人",
    "扫把", "牙刷", "手电筒", "三明治", "雪花", "葫芦", "磁铁", "口琴", "树屋",
)
_THEMES = {
    "everyday": ("闹钟", "书包", "牙刷", "台灯", "剪刀", "保温杯", "钥匙", "吹风机"),
    "nature": ("长颈鹿", "海豚", "仙人掌", "瀑布", "袋鼠", "松鼠", "龙卷风", "珊瑚"),
    "adventure": ("热气球", "藏宝图", "潜水艇", "宇航员", "海盗船", "探险家", "滑翔伞", "登山杖"),
}
_MAX_ACTIVE_BOARDS = 12
_MAX_FINISHED_BOARDS = 50
_MAX_GUESS_HISTORY = 50
_MAX_PLAYERS = 32
_CORRECT_EXP = 5


class DrawGuessGame(Base):
    __tablename__ = "draw_guess_games"

    room_id = Column(PG_UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), primary_key=True)
    state = Column(JSONB, nullable=False)


class DrawGuessBoard(Base):
    __tablename__ = "draw_guess_boards"
    __table_args__ = (Index("ix_draw_guess_boards_room_ends", "room_id", "ends_at"),)

    id = Column(PG_UUID(as_uuid=True), primary_key=True)
    room_id = Column(PG_UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False)
    drawer_id = Column(PG_UUID(as_uuid=True), nullable=False)
    ends_at = Column(BigInteger, nullable=False)
    state = Column(JSONB, nullable=False)


class BoardInput(BaseModel):
    duration_seconds: Literal[30, 60, 90, 120, 180, 300] = 120
    category: Literal["everyday", "nature", "adventure"] | None = None
    answer: str | None = Field(default=None, max_length=8)
    hint: str | None = Field(default=None, max_length=30)


class RoundInput(BaseModel):
    round_id: UUID


class NextInput(RoundInput):
    role: Literal["drawer", "guesser"] = "guesser"


class CanvasInput(RoundInput):
    canvas_version: int = Field(ge=0)


class Point(BaseModel):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class StrokeInput(CanvasInput):
    color: str = Field(min_length=7, max_length=7, pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(ge=1, le=32, allow_inf_nan=False)
    points: list[Point] = Field(min_length=1, max_length=128)


class GuessInput(RoundInput):
    text: str = Field(min_length=1, max_length=64)


def _now() -> int:
    return time_ns() // 1_000_000


def _name(user: User) -> str:
    return user.nickname or user.username or "群成员"


async def _viewer(
    room_id: UUID, response: Response, db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_active_user),
) -> GroupMember:
    await _room(db, room_id)
    member = await db.scalar(select(GroupMember).where(
        GroupMember.room_id == room_id, GroupMember.user_id == user.id,
    ))
    if member is None:
        raise HTTPException(403, "仅群成员可参与游戏")
    response.headers["Cache-Control"] = "no-store"
    return member


def _end_reason(ends_at: int, state: dict, now: int) -> str | None:
    return state.get("ended_reason") or ("timeout" if now >= ends_at else None)


def _can_manage(board: DrawGuessBoard, member: GroupMember) -> bool:
    return board.drawer_id == member.user_id or member.role in {"owner", "admin"}


async def _load(db: AsyncSession, room_id: UUID, board_id: UUID, lock: bool = False) -> DrawGuessBoard:
    stmt = select(DrawGuessBoard).where(DrawGuessBoard.room_id == room_id, DrawGuessBoard.id == board_id)
    board = await db.scalar(stmt.with_for_update() if lock else stmt)
    if board is None:
        raise HTTPException(404, "画板不存在或已归档")
    return board


async def _live(db: AsyncSession, room_id: UUID, board_id: UUID, round_id: UUID) -> tuple[DrawGuessBoard, dict, int]:
    board = await _load(db, room_id, board_id, lock=True)
    state = dict(board.state)
    now = _now()
    expected_round = state.get("round_id") or str(board.id)
    if str(round_id) != str(expected_round) or _end_reason(board.ends_at, state, now):
        raise HTTPException(409, "该轮已结束或已切换")
    return board, state, now


async def _view(db: AsyncSession, board: DrawGuessBoard, member: GroupMember) -> dict:
    state = board.state
    now = _now()
    reason = _end_reason(board.ends_at, state, now)
    names = state["names"]
    drawer = str(board.drawer_id)
    winner = state.get("winner_id")
    viewer = str(member.user_id)
    standings = await db.scalar(select(DrawGuessGame.state).where(DrawGuessGame.room_id == board.room_id)) or {}
    scores = sorted(standings.get("scores", {}).items(), key=lambda pair: (-pair[1], pair[0]))[:30]
    score_names = standings.get("names", {})
    return {
        "board_id": board.id, "round_id": state.get("round_id", str(board.id)),
        "round_no": int(state.get("round_no", 1)),
        "status": "finished" if reason else "drawing",
        "drawer_id": drawer, "drawer_name": names.get(drawer) or "群成员",
        "answer": state["answer"] if reason or board.drawer_id == member.user_id else None,
        "answer_length": len(state["answer"]), "hint": state.get("hint", ""),
        "ends_at": board.ends_at, "server_time": now, "ended_reason": reason,
        "canvas_version": state["canvas_version"], "strokes": state["strokes"],
        "winner_id": winner, "winner_name": names.get(winner),
        "joined": viewer in names, "can_end": not reason and _can_manage(board, member),
        "guesses": state["guesses"][-_MAX_GUESS_HISTORY:],
        "scores": [{"user_id": uid, "score": score, "name": score_names.get(uid) or "群成员"} for uid, score in scores],
    }


async def _save(db: AsyncSession, board: DrawGuessBoard, member: GroupMember, state: dict) -> dict:
    board.state = state
    await db.flush()
    result = await _view(db, board, member)
    await db.commit()
    return result


async def prune_board_history(db: AsyncSession) -> int:
    now = _now()
    ranked = select(
        DrawGuessBoard.id,
        func.row_number().over(
            partition_by=DrawGuessBoard.room_id,
            order_by=(DrawGuessBoard.ends_at.desc(), DrawGuessBoard.id),
        ).label("position"),
    ).where(DrawGuessBoard.ends_at <= now).subquery()
    stale = select(DrawGuessBoard.id).join(ranked, ranked.c.id == DrawGuessBoard.id).where(
        ranked.c.position > _MAX_FINISHED_BOARDS,
    ).limit(500).with_for_update(of=DrawGuessBoard, skip_locked=True)
    result = await db.execute(delete(DrawGuessBoard).where(DrawGuessBoard.id.in_(stale)))
    await db.commit()
    return result.rowcount


async def auto_end_expired_boards(db: AsyncSession) -> int:
    rows = (await db.execute(select(DrawGuessBoard.id).where(
        DrawGuessBoard.ends_at <= _now(),
        DrawGuessBoard.state["ended_reason"].as_string().is_(None),
    ).order_by(DrawGuessBoard.ends_at).limit(100))).scalars().all()
    ended = 0
    for board_id in rows:
        board = await db.scalar(select(DrawGuessBoard).where(
            DrawGuessBoard.id == board_id,
            DrawGuessBoard.ends_at <= _now(),
            DrawGuessBoard.state["ended_reason"].as_string().is_(None),
        ).with_for_update(skip_locked=True))
        if board is None:
            continue
        board.state = {**board.state, "ended_reason": "timeout"}
        await db.commit()
        ended += 1
    return ended


async def _play_user(db: AsyncSession, member: GroupMember) -> User:
    muted_until = member.muted_until
    if muted_until and muted_until.timestamp() * 1000 > _now():
        raise HTTPException(403, "禁言期间无法参与画猜")
    return await db.get(User, member.user_id)


@router.get("/boards")
async def list_boards(room_id: UUID, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    now = _now()
    query = select(
        DrawGuessBoard.id, DrawGuessBoard.ends_at,
        DrawGuessBoard.state["names"], DrawGuessBoard.state["ended_reason"], DrawGuessBoard.drawer_id,
    ).where(DrawGuessBoard.room_id == room_id).order_by(DrawGuessBoard.ends_at.desc(), DrawGuessBoard.id)
    rows = (await db.execute(query.where(DrawGuessBoard.ends_at > now))).all()
    rows += (await db.execute(query.where(DrawGuessBoard.ends_at <= now).limit(_MAX_FINISHED_BOARDS))).all()
    boards = []
    for board_id, ends_at, names, reason, drawer_id in rows:
        boards.append({
            "board_id": board_id, "drawer_name": names.get(str(drawer_id)) or "群成员",
            "status": "finished" if reason or ends_at <= now else "drawing",
            "participant_count": len(names), "ends_at": ends_at,
        })
    boards.sort(key=lambda board: board["status"] != "drawing")
    return {"boards": boards}


@router.post("/boards")
async def start(
    room_id: UUID, payload: BoardInput = BoardInput(),
    member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db),
):
    user = await _play_user(db, member)
    words = _THEMES[payload.category] if payload.category else _WORDS
    answer = normalize("NFKC", payload.answer or choice(words)).strip()
    hint = normalize("NFKC", payload.hint or "").strip()
    if not answer or len(answer) > 8:
        raise HTTPException(422, "题目需为 1–8 个字")
    blocked, _, clean_answer = sensitive_filter.scan(answer)
    if blocked or "".join(clean_answer.casefold().split()) != "".join(answer.casefold().split()):
        raise HTTPException(400, "题目未通过审核")
    if len(hint) > 30:
        raise HTTPException(422, "提示不能超过 30 字")
    if hint:
        blocked, _, clean_hint = sensitive_filter.scan(hint)
        if blocked:
            raise HTTPException(400, "提示未通过审核")
        hint = clean_hint
    await db.scalar(select(GroupRoom.id).where(GroupRoom.id == room_id).with_for_update(key_share=True))
    now = _now()
    active = (await db.scalars(select(DrawGuessBoard.drawer_id).where(
        DrawGuessBoard.room_id == room_id, DrawGuessBoard.ends_at > now,
    ))).all()
    if member.user_id in active:
        raise HTTPException(409, "你已有进行中的画板，请先结束该局")
    if len(active) >= _MAX_ACTIVE_BOARDS:
        raise HTTPException(409, "同时进行的画板已达上限，请加入已有画板")
    board = DrawGuessBoard(
        id=uuid4(), room_id=room_id, drawer_id=member.user_id,
        ends_at=now + payload.duration_seconds * 1000,
    )
    db.add(board)
    return await _save(db, board, member, {
        "names": {str(member.user_id): _name(user)}, "answer": answer, "hint": hint,
        "canvas_version": 0, "strokes": [], "point_count": 0,
        "winner_id": None, "ended_reason": None, "attempts": {}, "guesses": [],
        "round_id": str(uuid4()), "round_no": 1, "duration_seconds": payload.duration_seconds,
        "category": payload.category,
    })


@router.get("/boards/{board_id}/state")
async def get_state(room_id: UUID, board_id: UUID, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board = await _load(db, room_id, board_id)
    return await _view(db, board, member)


@router.post("/boards/{board_id}/join")
async def join(room_id: UUID, board_id: UUID, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board = await _load(db, room_id, board_id, lock=True)
    state = dict(board.state)
    viewer = str(member.user_id)
    if _end_reason(board.ends_at, state, _now()) or viewer in state["names"]:
        return await _view(db, board, member)
    if len(state["names"]) >= _MAX_PLAYERS:
        raise HTTPException(409, "该画板人数已满，请选择其他画板")
    user = await _play_user(db, member)
    state["names"] = {**state["names"], viewer: _name(user)}
    return await _save(db, board, member, state)


def _canvas(board: DrawGuessBoard, state: dict, member: GroupMember, version: int):
    if board.drawer_id != member.user_id:
        raise HTTPException(403, "只有本轮画手可以操作画板")
    if state["canvas_version"] != version:
        raise HTTPException(409, "画板已刷新")


@router.post("/boards/{board_id}/stroke")
async def stroke(room_id: UUID, board_id: UUID, payload: StrokeInput, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board, state, _ = await _live(db, room_id, board_id, payload.round_id)
    _canvas(board, state, member, payload.canvas_version)
    count = state["point_count"] + len(payload.points)
    if len(state["strokes"]) >= 256 or count > 4096:
        raise HTTPException(409, "画板已满，请清空后继续绘画")
    state["strokes"] = [*state["strokes"], {
        "color": payload.color.lower(), "width": round(payload.width, 2),
        "points": [{"x": round(p.x, 5), "y": round(p.y, 5)} for p in payload.points],
    }]
    state["point_count"] = count
    return await _save(db, board, member, state)


@router.post("/boards/{board_id}/clear")
async def clear(room_id: UUID, board_id: UUID, payload: CanvasInput, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board, state, _ = await _live(db, room_id, board_id, payload.round_id)
    _canvas(board, state, member, payload.canvas_version)
    state.update(canvas_version=state["canvas_version"] + 1, strokes=[], point_count=0)
    return await _save(db, board, member, state)


@router.post("/boards/{board_id}/end")
async def end(room_id: UUID, board_id: UUID, payload: RoundInput, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board, state, now = await _live(db, room_id, board_id, payload.round_id)
    if not _can_manage(board, member):
        raise HTTPException(403, "只有画手和群管理员可以结束画板")
    board.ends_at = now
    state["ended_reason"] = "manual"
    return await _save(db, board, member, state)


async def _score(db: AsyncSession, room_id: UUID, viewer: str, name: str):
    await db.execute(insert(DrawGuessGame).values(room_id=room_id, state={}).on_conflict_do_nothing())
    game = await db.scalar(select(DrawGuessGame).where(DrawGuessGame.room_id == room_id).with_for_update())
    scores = dict(game.state.get("scores", {}))
    scores[viewer] = scores.get(viewer, 0) + 1
    game.state = {"scores": scores, "names": {**game.state.get("names", {}), viewer: name}}


@router.post("/boards/{board_id}/next")
async def next_round(room_id: UUID, board_id: UUID, payload: NextInput,
                     member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    """本轮结束后开启下一轮。

    - role=drawer：当前用户接管画笔（换人画 / 继续画）
    - role=guesser：保留当前画手，只换一道新题（继续猜）
    画布、猜词、计时都会重置，玩家与积分保留。
    """
    board = await _load(db, room_id, board_id, lock=True)
    state = dict(board.state)
    now = _now()
    if not _end_reason(board.ends_at, state, now):
        raise HTTPException(409, "本轮还没有结束")
    user = await _play_user(db, member)
    viewer = str(member.user_id)

    if payload.role == "drawer":
        board.drawer_id = member.user_id
    else:
        current_drawer = str(board.drawer_id)
        if current_drawer not in state.get("names", {}):
            raise HTTPException(409, "当前画手已离开，请选择「继续画」接手")

    category = state.get("category")
    words = _THEMES.get(category, _WORDS)
    pool = [w for w in words if w != state.get("answer")] or list(words)
    answer = choice(pool)
    duration = int(state.get("duration_seconds", 120))
    board.ends_at = now + duration * 1000
    state.update(
        names={**state.get("names", {}), viewer: _name(user)},
        answer=answer, hint="", canvas_version=int(state.get("canvas_version", 0)) + 1,
        strokes=[], point_count=0, winner_id=None, ended_reason=None,
        attempts={}, guesses=[],
        round_id=str(uuid4()), round_no=int(state.get("round_no", 1)) + 1,
        duration_seconds=duration, category=category,
    )
    return await _save(db, board, member, state)


@router.post("/boards/{board_id}/guess")
async def guess(room_id: UUID, board_id: UUID, payload: GuessInput, member: GroupMember = Depends(_viewer), db: AsyncSession = Depends(get_db)):
    board, state, now = await _live(db, room_id, board_id, payload.round_id)
    viewer = str(member.user_id)
    if board.drawer_id == member.user_id:
        raise HTTPException(403, "画手不能参与猜词")
    if viewer not in state["names"]:
        raise HTTPException(403, "请先加入该画板")
    user = await _play_user(db, member)
    text = normalize("NFKC", payload.text).strip()[:64]
    if not text:
        raise HTTPException(422, "请输入猜测内容")
    blocked, _, clean = sensitive_filter.scan(text)
    if blocked:
        raise HTTPException(400, "猜测内容未通过审核")
    attempts = dict(state["attempts"])
    count, last = attempts.get(viewer, (0, 0))
    if count >= 12 or now - last < 1500:
        raise HTTPException(429, "猜词太频繁，或已用完本轮 12 次猜词机会")
    attempts[viewer] = (count + 1, now)
    state["attempts"] = attempts
    correct = "".join(clean.casefold().split()) == "".join(state["answer"].casefold().split())
    name = _name(user)
    state["guesses"] = [*state["guesses"][-(_MAX_GUESS_HISTORY - 1):], {
        "user_id": viewer, "name": name, "text": clean, "ts": now, "correct": correct,
    }]
    exp = None
    if correct:
        from app.routers.chat import award_group_exp_flat

        locked_member = await db.scalar(select(GroupMember).where(GroupMember.id == member.id)
                                        .with_for_update().execution_options(populate_existing=True))
        if locked_member is None:
            raise HTTPException(403, "仅群成员可参与游戏")
        exp = await award_group_exp_flat(db, locked_member, _CORRECT_EXP)
        await _score(db, room_id, viewer, name)
        board.ends_at = now
        state.update(winner_id=viewer, ended_reason="guessed", names={**state["names"], viewer: name})
    result = await _save(db, board, member, state)
    if exp is not None:
        result.update(exp_gained=exp["gain"], group_level=exp["group_level"],
                      level_up=exp["level_up"], daily_exp_left=exp["daily_left"])
    return result
