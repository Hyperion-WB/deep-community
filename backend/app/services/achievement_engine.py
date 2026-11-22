import logging
"""勋章自动判定引擎

按用户真实数据计算 10 个分级系列的进度，并在跨过阈值时自动升级；
同时判定可自动完成的一次性成就。所有写入都是幂等的（唯一约束 + 只升不降）。
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timezone import utc_now
from app.models.achievement import AchievementDef, UserAchievement
from app.models.comment import Comment
from app.models.post import Post, Collection
from app.models.system import Notification
from app.models.user import User, Checkin, Follow

logger = logging.getLogger(__name__)

# 系列 -> (统计字段, 单位)
SERIES_UNITS = {
    "quill": ("posts", "篇"),
    "resonance": ("likes", "赞"),
    "dwell": ("active_days", "天"),
    "bond": ("followers", "人"),
    "debate": ("comments", "条"),
    "library": ("collections", "次"),
    "evangel": ("code_posts", "篇"),
    "nightowl": ("night_posts", "次"),
    "archae": ("checkins", "天"),
    "anniv": ("years", "年"),
}

SERIES_NAMES = {
    "quill": "执笔", "resonance": "共鸣", "dwell": "常驻", "bond": "连接",
    "debate": "辩手", "library": "藏书", "evangel": "布道", "nightowl": "夜行",
    "archae": "考古", "anniv": "纪年",
}


async def collect_stats(db: AsyncSession, user: User) -> Dict[str, int]:
    posts = await db.scalar(
        select(func.count(Post.id)).where(Post.author_id == user.id, Post.status == "published")
    )
    likes = await db.scalar(
        select(func.coalesce(func.sum(Post.like_count), 0)).where(
            Post.author_id == user.id, Post.status == "published"
        )
    )
    comments = await db.scalar(
        select(func.count(Comment.id)).where(Comment.author_id == user.id, Comment.status == "visible")
    )
    collections = await db.scalar(select(func.count(Collection.id)).where(Collection.user_id == user.id))
    followers = await db.scalar(
        select(func.count(Follow.id)).where(Follow.following_id == user.id)
    )
    checkins = await db.scalar(select(func.count(Checkin.id)).where(Checkin.user_id == user.id))
    code_posts = await db.scalar(
        select(func.count(Post.id)).where(
            Post.author_id == user.id,
            Post.status == "published",
            Post.content_md.contains("```"),
        )
    )
    # 深夜发文：按 created_at 的小时近似统计（容器时区为 Asia/Shanghai）
    night_posts = await db.scalar(
        select(func.count(Post.id)).where(
            Post.author_id == user.id,
            Post.status == "published",
            # createdAt 是 timestamptz，先转到业务时区再取小时，否则会按 UTC 偏移 8 小时
            func.extract("hour", func.timezone("Asia/Shanghai", Post.created_at)).in_([0, 1, 2, 3, 4, 5]),
        )
    )
    created = user.created_at or utc_now()
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    years = max(0, int((utc_now() - created).days // 365))

    return {
        "posts": int(posts or 0),
        "likes": int(likes or 0),
        "active_days": int(user.active_days or 0),
        "followers": int(followers or 0),
        "comments": int(comments or 0),
        "collections": int(collections or 0),
        "checkins": int(checkins or 0),
        "code_posts": int(code_posts or 0),
        "night_posts": int(night_posts or 0),
        "years": years,
    }


EVAL_THROTTLE_SECONDS = 60


async def evaluate_user(db: AsyncSession, user: User) -> Dict[str, Any]:
    """计算并写入该用户的勋章状态，返回系列进度快照（Redis 节流 60 秒）"""
    # 节流：同一用户 60 秒内只做一次完整统计，避免刷主页造成写放大；
    # 命中节流时返回上次的快照，而不是空列表（否则前端会显示 0/已满级 的错误状态）
    cache_key = f"wb:achv:series:{user.id}"
    try:
        from app.core.database import get_redis
        redis = get_redis()
        if redis and not await redis.set(f"wb:achv:eval:{user.id}", "1", ex=EVAL_THROTTLE_SECONDS, nx=True):
            cached = await redis.get(cache_key)
            if cached:
                import json as _json
                return _json.loads(cached)
            return {"stats": {}, "series": []}
    except Exception:
        pass

    stats = await collect_stats(db, user)

    defs = (await db.execute(select(AchievementDef).where(AchievementDef.active.is_(True)))).scalars().all()
    owned = {
        ua.code: ua
        for ua in (
            await db.execute(select(UserAchievement).where(UserAchievement.user_id == user.id))
        ).scalars().all()
    }

    series_progress: Dict[str, Dict[str, Any]] = {}
    unlocked_names: List[str] = []

    for definition in defs:
        if definition.category != "series" or not definition.series:
            continue
        metric, unit = SERIES_UNITS.get(definition.series, ("posts", ""))
        current = stats.get(metric, 0)
        bucket = series_progress.setdefault(
            definition.series,
            {"series": definition.series, "name": SERIES_NAMES.get(definition.series, definition.series),
             "icon": definition.icon, "current": current, "unit": unit, "tier": -1,
             "next": None, "targets": []},
        )
        bucket["targets"].append({"tier": definition.tier, "target": definition.target})
        if current >= definition.target:
            bucket["tier"] = max(bucket["tier"], definition.tier)
        elif bucket["next"] is None:
            bucket["next"] = {"tier": definition.tier, "target": definition.target}

        # 达标即授予（只升不降）
        # 注意：targets 已在上面 append 过一次，这里再 append 会导致
        # 「执笔」这类系列勋章在详情弹窗里每个档位出现两遍（铜/铜/银/银…）
        if current >= definition.target:
            record = owned.get(definition.code)
            if record is None:
                db.add(UserAchievement(user_id=user.id, code=definition.code, tier=definition.tier, progress=current))
                unlocked_names.append(f"{SERIES_NAMES.get(definition.series, definition.series)}·{'铜银金钻'[definition.tier]}")
            elif record.revoked_at is None and (record.tier or 0) < definition.tier:
                record.tier = definition.tier
                record.progress = current
                unlocked_names.append(f"{SERIES_NAMES.get(definition.series, definition.series)}·{'铜银金钻'[definition.tier]}（升级）")

    # ---- 一次性成就自动判定 ----
    first_post = stats["posts"] > 0
    first_comment = stats["comments"] > 0
    featured = bool(await db.scalar(
        select(func.count(Post.id)).where(Post.author_id == user.id, Post.is_essence.is_(True))
    ))
    max_like = int(await db.scalar(
        select(func.coalesce(func.max(Post.like_count), 0)).where(Post.author_id == user.id)
    ) or 0)
    has_long = bool(await db.scalar(
        select(func.count(Post.id)).where(
            Post.author_id == user.id, func.length(Post.content_md) >= 10000
        )
    ))
    max_streak = int(await db.scalar(
        select(func.coalesce(func.max(Checkin.continuous_days), 0)).where(Checkin.user_id == user.id)
    ) or 0)
    profile_complete = all(
        [bool(user.avatar_url), bool((user.bio or "").strip()), bool((user.tech_stack or "").strip()),
         bool((user.github_url or "").strip())]
    )

    auto_map = {
        "special_first_post": first_post,
        "special_first_comment": first_comment,
        "special_featured": featured > 0,
        "special_100_likes": max_like >= 100,
        "special_10k_words": has_long,
        "special_streak_30": max_streak >= 30,
        "special_profile_complete": profile_complete,
    }
    for code, ok in auto_map.items():
        if not ok:
            continue
        definition = next((d for d in defs if d.code == code), None)
        if definition is None:
            continue
        record = owned.get(code)
        if record is None:
            db.add(UserAchievement(user_id=user.id, code=code, tier=definition.tier, progress=1))
            unlocked_names.append(definition.name)
        elif record.revoked_at is not None:
            record.revoked_at = None

    # 一次评估只发一条汇总通知，避免首登/首次发帖被刷屏
    if unlocked_names:
        preview = "、".join(unlocked_names[:3])
        more = f" 等 {len(unlocked_names)} 项" if len(unlocked_names) > 3 else ""
        db.add(Notification(
            receiver_id=user.id,
            action_type="level_up",
            brief=f"解锁新成就：{preview}{more}",
        ))

    await db.commit()

    payload = {"stats": stats, "series": list(series_progress.values()), "unlocked": unlocked_names}
    try:
        from app.core.database import get_redis
        import json as _json
        redis = get_redis()
        if redis:
            await redis.set(cache_key, _json.dumps(payload, ensure_ascii=False), ex=EVAL_THROTTLE_SECONDS)
    except Exception:
        pass
    return payload


EGG_CODES: set[str] = set()  # 开源版不内置彩蛋：接口保留，内容为空

# 业务时区固定为 Asia/Shanghai：容器时区可能因镜像/挂载变化而不同，
# 写死时区可避免「夜猫子」在白天的 08:00-13:00 被误触发
BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


async def unlock_egg(db: AsyncSession, user: User, code: str) -> Dict[str, Any]:
    """开源版：彩蛋接口保留，但不提供任何彩蛋内容与判定逻辑。"""
    return {"unlocked": False, "reason": "disabled"}


async def snapshot_series(db: AsyncSession, user: User) -> List[Dict[str, Any]]:
    """只读快照：计算系列进度但不授予、不写库（用于查看他人主页）"""
    stats = await collect_stats(db, user)
    defs = (await db.execute(
        select(AchievementDef).where(AchievementDef.category == "series", AchievementDef.active.is_(True))
    )).scalars().all()
    owned = {
        ua.code: ua
        for ua in (await db.execute(
            select(UserAchievement).where(UserAchievement.user_id == user.id, UserAchievement.revoked_at.is_(None))
        )).scalars().all()
    }

    buckets: Dict[str, Dict[str, Any]] = {}
    for d in defs:
        if not d.series:
            continue
        metric, unit = SERIES_UNITS.get(d.series, ("posts", ""))
        bucket = buckets.setdefault(d.series, {
            "series": d.series,
            "name": SERIES_NAMES.get(d.series, d.series),
            "icon": d.icon,
            "current": int(stats.get(metric, 0)),
            "unit": unit,
            "tier": -1,
            "next": None,
            "targets": [],
        })
        bucket["targets"].append({"tier": d.tier, "target": d.target})
        if d.code in owned:
            bucket["tier"] = max(bucket["tier"], d.tier)
        if bucket["current"] >= d.target:
            bucket["tier"] = max(bucket["tier"], d.tier)
        elif bucket["next"] is None:
            bucket["next"] = {"tier": d.tier, "target": d.target}
    return list(buckets.values())
