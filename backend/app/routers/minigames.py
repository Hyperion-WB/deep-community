"""404 游戏平台：注册中心 / 赛季积分 / 反作弊 / 总榜 / 历史回看。

计分口径（用户确认）：**难度系数 × 完成度 ÷ 用时**，统一换算到 0–100 赛季分。
    completion = 1.0（完成型游戏通关）或 min(原始分 / 目标分, 1.0)
    time_eff   = min(1.0, 参考用时 / 实际用时)   ← 用时越长得分越低
    season     = 100 × (难度系数 / 2.0) × completion × time_eff

反作弊：所有成绩必须绑定服务端签发的 run_id，一局只结算一次，
并校验用时与服务端时间一致、分数上限、每日局数上限。
"""
import logging
import math
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import AliasChoices, BaseModel, Field, FiniteFloat, StrictBool, StrictInt
from sqlalchemy import desc, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.game_platform import (
    BattleSeasonStat, GameDef, GameRun, SeasonRegistry, SeasonScore, SeasonSnapshot,
)
from app.models.minigame import MinigameScore
from app.models.user import User
from app.routers.deps import get_current_user, get_current_user_optional

router = APIRouter(prefix="/minigames", tags=["小游戏"])
logger = logging.getLogger(__name__)

BUSINESS_TZ = ZoneInfo("Asia/Shanghai")
RANK_LIMIT = 10
DAILY_RUN_LIMIT = 30
RUN_TTL_HOURS = 2
MAX_DIFFICULTY = 2.0
# P1：确定性较高的三款，服务端校验操作序列与时长的一致性
P1_REPLAY_GAMES = {"2048", "minesweeper", "shudu"}
# 分数型：原始分越高越好；完成型：胜负 + 进度 + 步数/用时效率
SCORE_GAMES = {"2048", "dino", "tetris", "match3", "snake"}
COMPLETION_GAMES = {"shudu", "memory", "sokoban", "minesweeper"}
# 完成型「越少越好」指标的基准值（步数 / 秒数），用于连续效率系数
OPTIMAL_UNITS = {"shudu": 180, "memory": 12, "sokoban": 20, "minesweeper": 90}
MAX_GAME_DIFFICULTY_LEVEL = {"dino": 3, "shudu": 4, "memory": 3, "tetris": 3, "minesweeper": 3}

TIER_TITLES = {
    "bronze": "迷路玩家",
    "silver": "迷途高手",
    "gold": "迷途霸主",
}

MOYU_MEDALS = {
    "overall": ["月度摸鱼战神", "月度惜败高手", "月度运气选手"],
    "streak": ["不死连杀王", "稳赢机器", "好运传送带"],
    "wins": ["老牌赢麻大师", "对局劳模", "长期上分选手"],
}


def current_season_id() -> str:
    return datetime.now(BUSINESS_TZ).strftime("%Y-%m")


def valid_season(season: str) -> bool:
    try:
        year, month = map(int, season.split("-"))
        return 1 <= year <= 9999 and 1 <= month <= 12 and season == f"{year:04d}-{month:02d}"
    except ValueError:
        return False


class ScoreMetrics(BaseModel):
    raw: Optional[StrictInt] = Field(None, ge=0, le=10_000_000)
    elapsed_ms: StrictInt = Field(0, ge=0, le=7_200_000,
                                  validation_alias=AliasChoices("elapsedMs", "elapsed_ms"))
    moves: StrictInt = Field(0, ge=0, le=100_000)
    level: StrictInt = Field(1, ge=1, le=100_000)
    difficulty_level: StrictInt = Field(1, ge=1, le=100_000,
                                        validation_alias=AliasChoices("difficultyLevel", "difficulty_level"))
    progress: FiniteFloat = Field(0.0, strict=True, ge=0, le=1)
    won: StrictBool = False
    finished: Optional[StrictBool] = None


class ScoreEvent(BaseModel):
    t: StrictInt = Field(ge=0, le=7_200_000)
    k: str = Field(max_length=24)
    v: str = Field(max_length=24)


class ScorePayload(BaseModel):
    run_id: uuid.UUID
    score: StrictInt = Field(0, ge=0, le=10_000_000)
    duration_ms: StrictInt = Field(0, ge=0, le=7_200_000)
    completed: StrictBool = False
    difficulty: FiniteFloat = Field(1.0, ge=0.5, le=2.0)
    event_log: Optional[List[ScoreEvent]] = Field(None, max_length=5000)
    metrics: Optional[ScoreMetrics] = None


async def get_def(db: AsyncSession, game: str) -> GameDef:
    d = (await db.execute(select(GameDef).where(GameDef.code == game))).scalar_one_or_none()
    if not d or not d.enabled:
        raise HTTPException(status_code=404, detail="未知的游戏")
    return d


async def enabled_games(db: AsyncSession, zone: Optional[str] = None) -> List[GameDef]:
    q = select(GameDef).where(GameDef.enabled.is_(True))
    if zone:
        q = q.where(GameDef.zone == zone)
    return (await db.execute(q.order_by(GameDef.sort_order, GameDef.code))).scalars().all()


def percentile(rank: int, total: int) -> float:
    if total <= 1:
        return 100.0
    return round(100.0 * (1.0 - (rank - 1) / (total - 1)), 2)


def ranked(ordered, score_getter):
    previous = None
    rank = 0
    for position, item in enumerate(ordered, 1):
        score = score_getter(item)
        if score != previous:
            rank = position
            previous = score
        yield rank, item


# ==================== 注册中心 / 赛季 ====================

@router.get("/games")
async def list_games(db: AsyncSession = Depends(get_db)):
    """游戏注册中心：前端 tab / 分区 / 榜单全部由这里下发，加游戏只需插一行。"""
    defs = await enabled_games(db)
    return {
        "zones": {"solo": "单人摸鱼池", "versus": "双人互坑局"},
        "season": current_season_id(),
        "games": [{
            "code": d.code, "name": d.name, "zone": d.zone, "engine": d.engine,
            "path": d.path, "difficulty": float(d.difficulty),
            "target_score": d.target_score, "ref_seconds": d.ref_seconds,
            "license": d.source_license,
        } for d in defs],
    }


@router.get("/seasons")
async def list_seasons(db: AsyncSession = Depends(get_db)):
    """历史赛季回看：已结算赛季 + 当前进行中的赛季。"""
    rows = (await db.execute(
        select(SeasonRegistry).order_by(desc(SeasonRegistry.season_id))
    )).scalars().all()
    settled = [r.season_id for r in rows if r.status == "settled"]
    cur = current_season_id()
    return {
        "current": cur,
        "seasons": [cur] + [s for s in settled if s != cur],
        "detail": [{
            "season_id": r.season_id, "status": r.status,
            "settled_at": r.settled_at.isoformat() if r.settled_at else None,
        } for r in rows],
    }


# ==================== 反作弊：签发与上报 ====================

@router.post("/{game}/run")
async def start_run(
    game: str = Path(..., max_length=32),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """每次开局签发独立凭证和随机种子。"""
    d = await get_def(db, game)
    if d.zone != "solo":
        raise HTTPException(status_code=400, detail="对战游戏不使用单人计分凭证")

    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"game-run:{user.id}:{game}"},
    )

    # 限流按「用户 + 游戏」分别统计：光切换 8 个游戏 tab 不该耗光额度
    today_start = datetime.now(BUSINESS_TZ).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc)
    used = await db.scalar(
        select(func.count()).select_from(GameRun).where(
            GameRun.user_id == user.id,
            GameRun.game == game,
            GameRun.started_at >= today_start,
        )
    )
    if (used or 0) >= DAILY_RUN_LIMIT:
        raise HTTPException(status_code=429, detail="该游戏今日次数已达上限，明天再来")

    run = GameRun(
        id=uuid.uuid4(), user_id=user.id, game=game,
        seed=uuid.uuid4().hex, started_at=utc_now(),
        difficulty=d.difficulty,
    )
    db.add(run)
    await db.commit()
    return {
        "run_id": str(run.id), "seed": run.seed,
        "difficulty": float(d.difficulty),
        "target_score": d.target_score, "ref_seconds": d.ref_seconds,
    }


@router.post("/{game}/score")
async def submit_score(
    game: str = Path(..., max_length=32),
    payload: ScorePayload = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """结算一局：绑定 run_id，服务端按统一公式换算 0-100 赛季分。"""
    if payload is None:
        raise HTTPException(status_code=422, detail="缺少成绩数据")
    d = await get_def(db, game)

    run = (await db.execute(
        select(GameRun).where(GameRun.id == payload.run_id, GameRun.user_id == user.id).with_for_update()
    )).scalar_one_or_none()
    if not run or run.game != game:
        raise HTTPException(status_code=400, detail="无效的对局凭证")
    if run.settled:
        raise HTTPException(status_code=409, detail="该局已结算，不能重复上报")
    if utc_now() - run.started_at > timedelta(hours=RUN_TTL_HOURS):
        raise HTTPException(status_code=400, detail="对局凭证已过期")

    server_ms = int((utc_now() - run.started_at).total_seconds() * 1000)
    if not 0 < payload.duration_ms <= server_ms + 2000:
        raise HTTPException(status_code=400, detail="对局时长异常，成绩未计入")
    if payload.score > max(1000, d.target_score * 20):
        raise HTTPException(status_code=400, detail="成绩超出合理范围，未计入")

    events = payload.event_log or []
    stamps = [event.t for event in events]
    if game in P1_REPLAY_GAMES and not stamps:
        raise HTTPException(status_code=400, detail="缺少有效的操作记录，成绩未计入")
    if stamps and (stamps != sorted(stamps) or stamps[-1] > payload.duration_ms + 2000):
        raise HTTPException(status_code=400, detail="操作序列时间异常，成绩未计入")
    if len(stamps) > 1 and payload.duration_ms / (len(stamps) - 1) < 25:
        raise HTTPException(status_code=400, detail="操作频率异常，成绩未计入")

    metrics = payload.metrics or ScoreMetrics()
    completion_game = game in COMPLETION_GAMES
    if ((metrics.raw is not None and metrics.raw != payload.score)
            or metrics.elapsed_ms > payload.duration_ms + 2000
            or metrics.difficulty_level > MAX_GAME_DIFFICULTY_LEVEL.get(game, 1)
            or (game not in {"match3", "sokoban", "tetris"} and metrics.level != 1)
            or (metrics.finished is not None and metrics.finished != payload.completed)
            or (metrics.won and not payload.completed)
            or (completion_game and metrics.won and metrics.progress != 1)):
        raise HTTPException(status_code=400, detail="对局指标不一致，成绩未计入")
    if completion_game and not payload.completed:
        raise HTTPException(status_code=400, detail="该局尚未结束，成绩未计入")
    # 采用凭证签发至上报的墙钟作为下限，避免客户端缩短用时来抬高分数。
    elapsed_sec = max(1.0, max(server_ms - 2000, payload.duration_ms, metrics.elapsed_ms) / 1000.0)
    ref_sec = max(1.0, float(d.ref_seconds))

    if game in SCORE_GAMES:
        # 分数型：本局原始分相对目标分的连续完成度
        completion = min(1.0, payload.score / max(1, d.target_score))
    else:
        # 完成型：胜利=1，失败/中途=进度分（输了不再拿满分）
        completion = 1.0 if metrics.won else min(0.99, metrics.progress)

    # 用时：连续递减曲线，用时越短分越高（旧的 min(1, ref/real) 几乎恒为 1）
    speed = max(0.35, 1.0 / (1.0 + elapsed_sec / ref_sec))

    # 完成型：步数/用时越少越强，避免所有人同分
    efficiency = 1.0
    if game in COMPLETION_GAMES and metrics.moves > 0:
        optimal = float(OPTIMAL_UNITS[game])
        efficiency = max(0.30, optimal / (optimal + metrics.moves))

    level_factor = min(1.30, 1.0 + 0.10 * (metrics.difficulty_level - 1))
    level_bonus = min(1.30, 1.0 + 0.05 * (metrics.level - 1))

    exact_score = (
        100.0 * (float(run.difficulty) / MAX_DIFFICULTY)
        * level_factor * completion * speed * efficiency * level_bonus
    )
    season_score = int(round(max(0.0, min(100.0, exact_score))))
    tiebreak = int(round(exact_score * 1000))   # 未截断的精确分，用于并列排序

    run.settled = True
    run.ended_at = utc_now()
    run.duration_ms = payload.duration_ms
    run.raw_score = payload.score
    run.completed = payload.completed
    run.payload = {"event_log": [event.model_dump() for event in events], "metrics": metrics.model_dump()}

    sid = run.ended_at.astimezone(BUSINESS_TZ).strftime("%Y-%m")
    await db.execute(
        text("SELECT pg_advisory_xact_lock_shared(hashtextextended(:key, 0))"),
        {"key": f"game-season:{sid}"},
    )
    season_insert = insert(SeasonScore).values(
        season_id=sid, game=game, user_id=user.id, season_score=season_score,
        best_raw=payload.score, runs=1, tiebreak=tiebreak,
    )
    await db.execute(season_insert.on_conflict_do_update(
        index_elements=[SeasonScore.season_id, SeasonScore.game, SeasonScore.user_id],
        set_={
            "runs": SeasonScore.runs + 1,
            "season_score": func.greatest(SeasonScore.season_score, season_insert.excluded.season_score),
            "tiebreak": func.greatest(SeasonScore.tiebreak, season_insert.excluded.tiebreak),
            "best_raw": func.greatest(SeasonScore.best_raw, season_insert.excluded.best_raw),
            "updated_at": run.ended_at,
        },
    ))

    # 完成型游戏以胜局的标准分作为历史最高分，失败仍保留参与记录。
    personal_best = payload.score if game in SCORE_GAMES else max(1, season_score) if metrics.won else 0
    history_insert = insert(MinigameScore).values(game=game, user_id=user.id, score=personal_best)
    await db.execute(history_insert.on_conflict_do_update(
        index_elements=[MinigameScore.game, MinigameScore.user_id],
        set_={"score": history_insert.excluded.score, "updated_at": run.ended_at},
        where=history_insert.excluded.score > MinigameScore.score,
    ))
    await db.commit()

    return {"ok": True, "season_score": season_score, "raw": payload.score, "season": sid}


# ==================== 榜单 ====================

async def _league_rows(db: AsyncSession, season_id: str, game: Optional[str] = None):
    q = select(SeasonScore, User.username, User.nickname, User.avatar_url).join(
        User, User.id == SeasonScore.user_id
    ).where(SeasonScore.season_id == season_id, User.status == "active")
    if game:
        q = q.where(SeasonScore.game == game)
    return (await db.execute(q)).all()


def _assemble(rows, score_getter, limit=RANK_LIMIT, user_id=None):
    ordered = sorted(
        rows,
        key=lambda r: (score_getter(r), getattr(r[0], "tiebreak", 0) or 0),
        reverse=True,
    )
    items = []
    for i, r in enumerate(ordered[:limit]):
        ss = r[0]
        items.append({
            "rank": i + 1, "user_id": str(ss.user_id),
            "username": r[1], "nickname": r[2] or r[1],
            "avatar_url": r[3] or "", "score": int(score_getter(r)),
        })
    my_rank = None
    if user_id:
        for i, r in enumerate(ordered):
            if r[0].user_id == user_id:
                my_rank = i + 1
                break
    return {"items": items, "my_rank": my_rank, "total": len(ordered)}


@router.get("/{game}/leaderboard")
async def leaderboard(
    game: str = Path(..., min_length=1, max_length=32),
    season: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: Optional[User] = Depends(get_current_user_optional),
):
    """单游戏独立榜：优先赛季分，历史赛季同样可回看；无赛季数据时回退历史最高分。"""
    await get_def(db, game)
    sid = season or current_season_id()
    if not valid_season(sid):
        raise HTTPException(status_code=400, detail="赛季格式应为 YYYY-MM")
    rows = await _league_rows(db, sid, game)
    if rows or season is not None:
        out = _assemble(rows, lambda r: r[0].season_score, user_id=user.id if user else None)
        return {"game": game, "season": sid, **out}

    # 无赛季参数的旧客户端仍可读取历史最高分。
    hist = (await db.execute(
        select(MinigameScore.score, MinigameScore.user_id, User.username, User.nickname, User.avatar_url)
        .join(User, User.id == MinigameScore.user_id)
        .where(MinigameScore.game == game, User.status == "active")
        .order_by(desc(MinigameScore.score), MinigameScore.updated_at.asc())
        .limit(RANK_LIMIT)
    )).all()
    items = [{
        "rank": i + 1, "user_id": str(uid), "username": un,
        "nickname": nn or un, "avatar_url": av or "", "score": int(sc),
    } for i, (sc, uid, un, nn, av) in enumerate(hist)]
    return {"game": game, "season": sid, "items": items, "my_rank": None, "total": len(items)}


async def _compute_overall(db: AsyncSession, season_id: str):
    """总榜 = 单人区(各游戏百分位平均)×0.6 + 对战区(胜场百分位)×0.4。"""
    defs = await enabled_games(db, "solo")
    solo_codes = {d.code for d in defs}
    rows = await _league_rows(db, season_id)
    grouped = defaultdict(list)
    for r in rows:
        if r[0].game in solo_codes:
            grouped[r[0].game].append(r)
    per_user = defaultdict(dict)
    for game, group in grouped.items():
        ordered = sorted(group, key=lambda r: r[0].season_score, reverse=True)
        n = len(ordered)
        for rank, r in ranked(ordered, lambda row: row[0].season_score):
            per_user[r[0].user_id][game] = percentile(rank, n)

    stats = (await db.execute(
        select(BattleSeasonStat, User.username, User.nickname, User.avatar_url)
        .join(User, User.id == BattleSeasonStat.user_id)
        .where(BattleSeasonStat.season_id == season_id, User.status == "active")
        .order_by(desc(BattleSeasonStat.wins))
    )).all()
    versus_p = {}
    for rank, r in ranked(stats, lambda row: row[0].wins):
        versus_p[r[0].user_id] = percentile(rank, len(stats))

    names = {}
    for r in rows:
        names[r[0].user_id] = (r[1], r[2] or r[1], r[3] or "")
    for r in stats:
        names[r[0].user_id] = (r[1], r[2] or r[1], r[3] or "")

    result = []
    for uid in set(per_user) | set(versus_p):
        solo = sum(per_user[uid].values()) / max(1, len(per_user[uid]))
        ver = versus_p.get(uid, 0.0)
        total = round(solo * 0.6 + ver * 0.4, 2)
        un, nn, av = names.get(uid, ("", "", ""))
        result.append({
            "user_id": str(uid), "username": un, "nickname": nn, "avatar_url": av,
            "solo_score": round(solo, 2), "versus_score": round(ver, 2),
            "total_score": total,
            "breakdown": {k: round(v, 2) for k, v in per_user[uid].items()},
        })
    result.sort(key=lambda item: (-item["total_score"], item["user_id"]))
    for rank, item in ranked(result, lambda row: row["total_score"]):
        item["rank"] = rank
    return result


@router.get("/overall")
async def overall_leaderboard(
    season: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: Optional[User] = Depends(get_current_user_optional),
):
    """跨游戏总榜。已结算赛季优先读归档快照，当前赛季实时算。"""
    sid = season or current_season_id()
    if not valid_season(sid):
        raise HTTPException(status_code=400, detail="赛季格式应为 YYYY-MM")
    snap = (await db.execute(
        select(SeasonSnapshot).where(SeasonSnapshot.season_id == sid)
        .order_by(SeasonSnapshot.rank, SeasonSnapshot.user_id)
    )).scalars().all()
    if snap:
        names = {}
        uids = [r.user_id for r in snap]
        for uid, un, nn, av in (await db.execute(
            select(User.id, User.username, User.nickname, User.avatar_url).where(User.id.in_(uids))
        )).all():
            names[uid] = (un, nn or un, av or "")
        items = []
        for r in snap:
            un, nn, av = names.get(r.user_id, ("", "", ""))
            items.append({
                "rank": r.rank, "user_id": str(r.user_id), "username": un,
                "nickname": nn, "avatar_url": av,
                "total_score": float(r.total_score),
                "breakdown": r.breakdown or {},
            })
    else:
        registry = await db.get(SeasonRegistry, sid) if sid < current_season_id() else None
        items = [] if registry and registry.status == "settled" else await _compute_overall(db, sid)

    return {
        "season": sid, "items": items[:RANK_LIMIT],
        "my_rank": next((i["rank"] for i in items if user and i["user_id"] == str(user.id)), None),
        "total": len(items),
    }


async def _battle_board(db: AsyncSession, season_id: str, key: str, title: str):
    rows = (await db.execute(
        select(BattleSeasonStat, User.username, User.nickname, User.avatar_url)
        .join(User, User.id == BattleSeasonStat.user_id)
        .where(BattleSeasonStat.season_id == season_id, User.status == "active")
    )).all()
    def val(r):
        return r[0].best_streak if key == "streak" else r[0].wins
    ordered = sorted(rows, key=val, reverse=True)
    items = [{
        "rank": i + 1, "user_id": str(r[0].user_id), "username": r[1],
        "nickname": r[2] or r[1], "avatar_url": r[3] or "",
        "score": int(val(r)), "wins": r[0].wins, "losses": r[0].losses,
    } for i, r in enumerate(ordered[:RANK_LIMIT])]
    return {"season": season_id, "title": title, "items": items, "total": len(ordered)}


@router.get("/streak")
async def streak_leaderboard(season: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)):
    sid = season or current_season_id()
    return await _battle_board(db, sid, "streak", "连胜榜")


@router.get("/wins")
async def wins_leaderboard(season: Optional[str] = Query(None), db: AsyncSession = Depends(get_db)):
    sid = season or current_season_id()
    return await _battle_board(db, sid, "wins", "累计胜利榜")


@router.get("/me/points")
async def my_points(
    season: Optional[str] = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sid = season or current_season_id()
    rows = (await db.execute(
        select(SeasonScore).where(SeasonScore.season_id == sid, SeasonScore.user_id == user.id)
    )).scalars().all()
    overall = await _compute_overall(db, sid)
    mine = next((x for x in overall if x["user_id"] == str(user.id)), None)
    return {
        "season": sid,
        "games": {r.game: r.season_score for r in rows},
        "overall": mine,
        "tiers": await get_minigame_tiers(db, user),
    }


@router.get("/me/status")
async def my_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    tiers = await get_minigame_tiers(db, user)
    rows = (await db.execute(
        select(MinigameScore.game, MinigameScore.score).where(MinigameScore.user_id == user.id)
    )).all()
    return {
        "bests": {g: int(s) for g, s in rows},
        "tiers": tiers,
        "titles": [TIER_TITLES[t] for t in tiers],
    }


# ==================== 实时段位（保持原有规则不变） ====================

async def get_minigame_tiers(db: AsyncSession, user: User) -> List[str]:
    mine = (await db.execute(
        select(MinigameScore.game, MinigameScore.score).where(MinigameScore.user_id == user.id)
    )).all()
    if not mine:
        return []
    tiers: List[str] = ["bronze"]
    for game, score in mine:
        if game in COMPLETION_GAMES and score <= 0:
            continue
        better = await db.scalar(
            select(func.count()).select_from(MinigameScore)
            .join(User, User.id == MinigameScore.user_id)
            .where(MinigameScore.game == game, MinigameScore.score > score, User.status == "active")
        )
        rank = (better or 0) + 1
        if rank == 1:
            tiers.extend(["gold", "silver"])
        elif rank <= 5:
            tiers.append("silver")
    return [t for t in ("gold", "silver", "bronze") if t in tiers]


async def get_minigame_titles(db: AsyncSession, user: User) -> set:
    return {TIER_TITLES[t] for t in await get_minigame_tiers(db, user)}


# ==================== 赛季结算（供 scheduler 调用） ====================

async def settle_game_season(db: AsyncSession, season_id: Optional[str] = None) -> Dict[str, Any]:
    """结算上一自然月：归档总榜、发放 9 枚摸鱼勋章、摘除上一批、开启新赛季。"""
    if season_id is None:
        now = datetime.now(BUSINESS_TZ)
        first = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        prev = first - timedelta(days=1)
        season_id = prev.strftime("%Y-%m")

    if not valid_season(season_id) or season_id >= current_season_id():
        raise ValueError("只能结算已结束且格式为 YYYY-MM 的赛季")
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"game-season:{season_id}"},
    )
    reg = await db.get(SeasonRegistry, season_id)
    if reg and reg.status == "settled":
        await db.commit()
        return {"season": season_id, "already_settled": True, "medals": []}

    overall = await _compute_overall(db, season_id)
    streak = (await _battle_board(db, season_id, "streak", "连胜榜"))["items"]
    wins = (await _battle_board(db, season_id, "wins", "累计胜利榜"))["items"]

    # 归档总榜快照
    for item in overall:
        existing = (await db.execute(
            select(SeasonSnapshot).where(
                SeasonSnapshot.season_id == season_id,
                SeasonSnapshot.user_id == uuid.UUID(item["user_id"]),
            )
        )).scalar_one_or_none()
        if existing:
            existing.total_score = item["total_score"]
            existing.breakdown = item["breakdown"]
            existing.rank = item["rank"]
        else:
            db.add(SeasonSnapshot(
                season_id=season_id, user_id=uuid.UUID(item["user_id"]),
                total_score=item["total_score"], breakdown=item["breakdown"],
                rank=item["rank"],
            ))

    # 佩戴整月：结算月的下个月。赛季补结只归档有效期已经结束的月份。
    y, m = map(int, season_id.split("-"))
    next_month = datetime(y + (m == 12), (m % 12) + 1, 1, tzinfo=BUSINESS_TZ)
    following = datetime(next_month.year + (next_month.month == 12),
                         (next_month.month % 12) + 1, 1, tzinfo=BUSINESS_TZ)
    expires = following - timedelta(seconds=1)
    winners = []
    if expires > utc_now():
        for board_key, rows in (("overall", overall), ("streak", streak), ("wins", wins)):
            for i, item in enumerate(rows[:3]):
                title = MOYU_MEDALS[board_key][i]
                uid = item["user_id"]
                winners.append({"board": board_key, "rank": i + 1, "title": title, "user_id": uid})
                await db.execute(text(
                    "INSERT INTO user_titles (user_id, title, source, expires_at) "
                    "VALUES (:uid, :title, 'moyu', :exp) "
                    "ON CONFLICT (user_id, title, source) DO UPDATE "
                    "SET expires_at = GREATEST(user_titles.expires_at, EXCLUDED.expires_at)"
                ), {"uid": uid, "title": title, "exp": expires})

    if reg:
        reg.status = "settled"
        reg.settled_at = utc_now()
    else:
        db.add(SeasonRegistry(
            season_id=season_id,
            starts_at=datetime(y, m, 1, tzinfo=BUSINESS_TZ),
            ends_at=next_month, status="settled", settled_at=utc_now(),
        ))
    await db.commit()
    logger.info("[GameSeason] %s 结算完成，发放 %d 枚勋章", season_id, len(winners))
    return {"season": season_id, "users": len(overall), "medals": winners}
