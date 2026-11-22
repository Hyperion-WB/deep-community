"""公开榜单与打卡热力图。

- 三个榜单：累计签到、当日抢早签、近 7 天活跃（综合发帖/评论/群聊/签到）
- 热力图：某个用户最近一年的每日活动量，用于 GitHub 风格打卡图
"""

from datetime import date, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.chat import GroupMessage
from app.models.comment import Comment
from app.models.post import Post
from app.models.user import Checkin, User

router = APIRouter(prefix="/stats", tags=["榜单与热力图"])


# 名次称号（固定对应第 1~5 名）
TITLES_TOTAL = [
    "签到活化石",
    "老牌打卡钉子户",
    "长期蹲岗选手",
    "签到常驻流民",
    "坚持混资历选手",
]
TITLES_EARLY = [
    "破晓抢签卷王",
    "闹钟忠实奴隶",
    "天没亮就上线",
    "迷迷糊糊抢先手",
    "勉强赶个早集",
]
TITLES_ACTIVE = [
    "话痨发电机",
    "楼中楼战神",
    "凑热闹专业户",
    "到处串门唠嗑",
    "间歇性冒泡选手",
]


def _rank_row(idx: int, u: User, metric: int, titles: List[str], unit: str) -> dict:
    return {
        "rank": idx + 1,
        "user_id": str(u.id),
        "username": u.username,
        "nickname": u.nickname,
        "avatar_url": u.avatar_url or "",
        "level": u.level,
        "title": titles[idx] if idx < len(titles) else "",
        "metric": metric,
        "metric_label": f"{metric} {unit}" if unit else str(metric),
    }


async def _streak_days(db: AsyncSession, user_id) -> int:
    """连续签到天数（从今天或昨天往前数）。"""
    rows = (await db.execute(
        select(Checkin.checkin_date)
        .where(Checkin.user_id == user_id)
        .order_by(Checkin.checkin_date.desc())
        .limit(400)
    )).scalars().all()
    if not rows:
        return 0
    today = date.today()
    # 今天还没签到时，从昨天开始算，避免中午就把连续天数清零
    cursor = today if rows[0] == today else today - timedelta(days=1)
    if rows[0] not in (today, today - timedelta(days=1)):
        return 0
    days = 0
    for d in rows:
        if d == cursor:
            days += 1
            cursor -= timedelta(days=1)
        elif d < cursor:
            break
    return days


@router.get("/leaderboards")
async def get_leaderboards(db: AsyncSession = Depends(get_db)):
    """三个榜单：累计签到时长 / 今日抢早签 / 近 7 天活跃。"""
    # ---------- 1) 连续签到榜（补签也计入连续天数） ----------
    # 口径：当前仍在延续的连续签到天数，谁最长谁排第一；不再按历史累计次数排
    today = date.today()
    window_start = today - timedelta(days=400)
    checkin_rows = (await db.execute(
        select(Checkin.user_id, Checkin.checkin_date).where(Checkin.checkin_date >= window_start)
    )).all()
    makeup_rows = (await db.execute(
        text("SELECT user_id, target_date FROM checkin_makeups WHERE target_date >= :s"),
        {"s": window_start},
    )).all()

    days_by_user: dict = {}
    for uid, d in list(checkin_rows) + list(makeup_rows):
        days_by_user.setdefault(uid, set()).add(d)

    all_users = (await db.execute(select(User).where(User.role != "super_admin"))).scalars().all()
    user_map = {u.id: u for u in all_users}

    scored = []
    for uid, days in days_by_user.items():
        if uid not in user_map:
            continue
        # 今天还没签到则从昨天起算，避免中午就清零
        cursor = today if today in days else today - timedelta(days=1)
        if cursor not in days:
            continue
        length = 0
        while cursor in days:
            length += 1
            cursor -= timedelta(days=1)
        if length > 0:
            scored.append((length, uid))
    scored.sort(key=lambda x: (-x[0], str(x[1])))

    total_board = []
    for idx, (length, uid) in enumerate(scored[:5]):
        user = user_map[uid]
        row = _rank_row(idx, user, length, TITLES_TOTAL, "天")
        row["streak"] = length
        row["metric_label"] = f"连续 {length} 天"
        total_board.append(row)

    # ---------- 2) 今日抢早签榜 ----------
    today = date.today()
    early_rows = (await db.execute(
        select(Checkin.user_id, Checkin.created_at)
        .join(User, User.id == Checkin.user_id)
        .where(Checkin.checkin_date == today, User.role != "super_admin")
        .order_by(Checkin.created_at.asc())
        .limit(5)
    )).all()

    early_board = []
    for idx, (uid, created_at) in enumerate(early_rows):
        user = (await db.execute(select(User).where(User.id == uid))).scalar_one_or_none()
        if not user:
            continue
        row = _rank_row(idx, user, 0, TITLES_EARLY, "")
        row["metric_label"] = created_at.astimezone(timezone(timedelta(hours=8))).strftime(
            "今日 %H:%M 抢先签到"
        ) if created_at else "今日已签到"
        early_board.append(row)

    # ---------- 3) 近 7 天活跃榜 ----------
    since = datetime.now(timezone.utc) - timedelta(days=7)
    # 综合活跃度：发帖 ×3 + 评论 ×2 + 群消息 ×1 + 签到 ×2
    score_sql = text(
        """
        SELECT u.id,
               u.username,
               u.nickname,
               u.avatar_url,
               u.level,
               (
                 COALESCE((SELECT count(*) FROM posts p WHERE p.author_id = u.id
                            AND p.created_at >= :since AND p.status <> 'deleted'), 0) * 3
               + COALESCE((SELECT count(*) FROM comments c WHERE c.author_id = u.id
                            AND c.created_at >= :since AND c.status = 'visible'), 0) * 2
               + COALESCE((SELECT count(*) FROM group_messages m WHERE m.sender_id = u.id
                            AND m.created_at >= :since), 0) * 1
               + COALESCE((SELECT count(*) FROM checkins k WHERE k.user_id = u.id
                            AND k.checkin_date >= :since_date), 0) * 2
               ) AS score
        FROM users u
        WHERE u.status <> 'banned' AND u.role <> 'super_admin'
        ORDER BY score DESC, u.active_days DESC
        LIMIT 5
        """
    )
    active_rows = (await db.execute(
        score_sql, {"since": since, "since_date": since.date()}
    )).all()

    active_board = []
    for idx, row in enumerate(active_rows):
        score = int(row.score or 0)
        if score <= 0:
            continue
        active_board.append({
            "rank": idx + 1,
            "user_id": str(row.id),
            "username": row.username,
            "nickname": row.nickname,
            "avatar_url": row.avatar_url or "",
            "level": row.level,
            "title": TITLES_ACTIVE[idx] if idx < len(TITLES_ACTIVE) else "",
            "metric": score,
            "metric_label": f"活跃度 {score}",
        })

    return {
        "total": total_board,
        "early": early_board,
        "active": active_board,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _local_date(dt) -> Optional[date]:
    """UTC 时间 → 服务器本地日期。

    签到日期是用 Python 的 date.today()（容器时区 Asia/Shanghai）写库的，
    如果这里直接用 PG 的 date(created_at)（默认 UTC），凌晨 0-8 点的帖子/评论
    会被算到前一天，热力图就会出现「明明今天发了帖，今天格子还是空的」。
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone().date()


@router.get("/heatmap")
async def get_checkin_heatmap(
    username: str = Query(..., max_length=64),
    days: int = Query(365, ge=30, le=365),
    db: AsyncSession = Depends(get_db),
):
    """打卡热力图：返回最近 N 天的签到日期、补签日期与活动量（发帖 / 评论）。

    签到与活动分开返回：以前只有合并后的 counts，导致「只发了帖没签到」的格子
    也打上对勾，看起来像是签到了，统计数据是错的。
    """
    user = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    since = date.today() - timedelta(days=days - 1)
    since_dt = datetime.combine(since, datetime.min.time()).replace(tzinfo=timezone.utc)

    checkin_rows = (await db.execute(
        select(Checkin.checkin_date).where(
            Checkin.user_id == user.id, Checkin.checkin_date >= since
        )
    )).scalars().all()
    post_times = (await db.execute(
        select(Post.created_at).where(
            Post.author_id == user.id,
            Post.status != "deleted",
            Post.created_at >= since_dt,
        )
    )).scalars().all()
    comment_times = (await db.execute(
        select(Comment.created_at).where(
            Comment.author_id == user.id,
            Comment.status == "visible",
            Comment.created_at >= since_dt,
        )
    )).scalars().all()

    makeup_rows = (await db.execute(text(
        "SELECT target_date FROM checkin_makeups WHERE user_id = :uid AND target_date >= :since"
    ), {"uid": str(user.id), "since": since})).scalars().all()

    counts: dict[str, int] = {}
    for dt in post_times:
        d = _local_date(dt)
        if d:
            counts[d.isoformat()] = counts.get(d.isoformat(), 0) + 2
    for dt in comment_times:
        d = _local_date(dt)
        if d:
            counts[d.isoformat()] = counts.get(d.isoformat(), 0) + 1

    total_checkins = (await db.execute(
        select(func.count()).select_from(Checkin).where(Checkin.user_id == user.id)
    )).scalar_one()

    return {
        "username": user.username,
        "days": days,
        "since": since.isoformat(),
        "today": date.today().isoformat(),
        # counts 仅表示「签到之外的活动量」，签到状态看 checkins
        "counts": counts,
        "checkins": [d.isoformat() for d in checkin_rows],
        "makeups": [d.isoformat() for d in makeup_rows if d],
        "total_checkins": int(total_checkins),
        "streak": await _streak_days(db, user.id),
        "registered_at": _local_date(user.created_at).isoformat() if user.created_at else None,
    }


BOARD_TITLE_MAP = {
    "签到活化石": ("total", 1), "老牌打卡钉子户": ("total", 2), "长期蹲岗选手": ("total", 3),
    "签到常驻流民": ("total", 4), "坚持混资历选手": ("total", 5),
    "破晓抢签卷王": ("early", 1), "闹钟忠实奴隶": ("early", 2), "天没亮就上线": ("early", 3),
    "迷迷糊糊抢先手": ("early", 4), "勉强赶个早集": ("early", 5),
    "话痨发电机": ("active", 1), "楼中楼战神": ("active", 2), "凑热闹专业户": ("active", 3),
    "到处串门唠嗑": ("active", 4), "间歇性冒泡选手": ("active", 5),
}


async def get_user_board_titles(db: AsyncSession, user: User) -> set[str]:
    """该用户当前上榜获得的称号集合（供佩戴校验复用）。"""
    from sqlalchemy.exc import ProgrammingError
    boards = {"total": [], "early": [], "active": []}
    try:
        data = await get_leaderboards(db)
    except Exception:
        return set()
    for key in boards:
        for row in data.get(key, []):
            if row.get("username") == user.username:
                boards[key].append(row.get("rank"))
    titles = set()
    for title, (board, rank) in BOARD_TITLE_MAP.items():
        if rank in boards[board]:
            titles.add(title)
    return titles
