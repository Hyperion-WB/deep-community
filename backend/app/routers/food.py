"""美食广场 + 午餐转盘。

设计要点：
- 美食帖是唯一的 Post（post_type=food_topic），卡片是二级内容，不进首页信息流；
- 点赞复用 likes 表（target_type=food_card），评论独立表；
- 群午餐盘按「群 + 日期」隔离，每天 0 点换新，支持管理员配置冻结时间；
- 转盘结果由服务端生成，前端只负责动画，保证公平。
"""
from __future__ import annotations

import json
import random
import secrets
import uuid
from pathlib import Path
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.chat import GroupMember, GroupRoom
from app.models.food import (
    DEFAULT_DISHES, QUICK_COMMENTS, FoodCard, FoodCardComment, LunchDish, LunchPool, LunchSpin,
    WheelPreset,
)
from app.models.post import Like, Post
from app.models.system import Notification
from app.models.user import User
from app.routers.deps import get_current_user

router = APIRouter(prefix="/food", tags=["美食广场"])
TZ = ZoneInfo("Asia/Shanghai")
SPIN_CARD_LIMIT = 1           # 转盘晒卡每天 1 张
MANUAL_CARD_LIMIT = 3         # 手动发卡每天 3 张
DAILY_CARD_LIMIT = SPIN_CARD_LIMIT + MANUAL_CARD_LIMIT
SPIN_LIMIT = 10               # 每人每天每群
DISH_PER_USER = 5
POOL_MIN, POOL_MAX = 24, 60
# 全量菜库（名称 + 一句介绍）：用于加菜联想、随机换一批、结果卡介绍
_DISH_PATH = Path(__file__).resolve().parent.parent / "data" / "dishes.json"
try:
    DISH_LIBRARY: list[dict] = json.loads(_DISH_PATH.read_text(encoding="utf-8"))
except Exception:  # 文件缺失时退化到内置默认菜
    DISH_LIBRARY = [{"名称": n, "简短介绍": ""} for n in DEFAULT_DISHES]
DISH_INTRO = {str(d.get("名称", "")): str(d.get("简短介绍", "")) for d in DISH_LIBRARY}


def _dish_intro(name: str) -> str:
    return DISH_INTRO.get(name, "")


WARM_WORDS = [
    "好好吃饭，才有力气对抗全世界。",
    "今天也要把胃和心情一起照顾好。",
    "一顿热饭，能解决八成的坏情绪。",
    "慢一点吃，生活的味道才跟得上。",
    "你认真吃饭的样子，很值得被记录。",
    "别急着赶路，先把这顿午饭吃好。",
    "人间烟火气，最抚凡人心。",
    "愿今天的这口饭，刚好合你胃口。",
    "吃饱了，才有力气把下午过得漂亮。",
    "今天的快乐，从这一口开始。",
    "认真对待每一餐的人，运气都不会太差。",
    "把烦恼先放一放，趁热吃。",
    "这一餐不必惊艳，合胃口就好。",
    "碗里有饭，心里有光。",
    "愿你今天的午餐，比昨天的更合心意。",
    "生活再忙，也别亏待自己的胃。",
    "热气腾腾的，才叫日子。",
    "先照顾好自己，再去照顾世界。",
    "今天也辛苦啦，吃顿好的犒劳一下。",
    "不管吃什么，记得慢慢嚼。",
    "一顿饭的时间，够把坏心情放凉。",
    "有饭有菜，就是很具体的幸福。",
    "愿这顿饭，刚好治愈今天的你。",
    "别只想着赶路，胃也需要被认真对待。",
    "好好吃饭，是成年人最朴素的浪漫。",
    "今天这份，看起来就很值得期待。",
    "一口热饭下肚，世界都温柔了一点。",
    "吃完这顿，再继续发光。",
    "愿你不止今天，每一顿都吃得开心。",
    "把想吃的都吃一遍，才不算辜负今天。",
]


# ---------------- 基础工具 ----------------

def _today() -> date:
    return datetime.now(TZ).date()


def _day_bounds() -> tuple[datetime, datetime]:
    """本地自然日的 UTC 起止，避免 func.date() 按数据库时区把凌晨算到前一天。"""
    start = datetime.combine(_today(), time.min, tzinfo=TZ).astimezone(timezone.utc)
    return start, start + timedelta(days=1)


def _now() -> datetime:
    return datetime.now(TZ)


def _norm(name: str) -> str:
    return "".join(name.strip().lower().split())[:32]


def _warm_word(seed: Optional[str] = None) -> str:
    rng = random.Random(seed) if seed else random
    return rng.choice(WARM_WORDS)


def _pool_cap(member_count: int) -> int:
    return max(POOL_MIN, min(POOL_MAX, member_count * 3))


async def _topic(db: AsyncSession) -> Post:
    post = (await db.execute(
        select(Post).where(Post.post_type == "food_topic", Post.status == "published").limit(1)
    )).scalar_one_or_none()
    if not post:
        raise HTTPException(status_code=503, detail="美食帖尚未初始化，请稍后再试")
    return post


async def _group_member(db: AsyncSession, room_id: uuid.UUID, user_id: uuid.UUID) -> Optional[GroupMember]:
    return (await db.execute(
        select(GroupMember).where(GroupMember.room_id == room_id, GroupMember.user_id == user_id)
    )).scalar_one_or_none()


def _can_manage(member: Optional[GroupMember], user: User) -> bool:
    return bool(member and member.role in ("owner", "admin")) or user.role in ("super_admin", "admin")


async def _member_count(db: AsyncSession, room_id: uuid.UUID) -> int:
    return int((await db.execute(
        select(func.count()).select_from(GroupMember).where(GroupMember.room_id == room_id)
    )).scalar() or 0)


async def _push_lunch_update(db: AsyncSession, room_id: uuid.UUID) -> None:
    """菜盘变更实时广播：加菜/删菜/冻结设置变化时通知群内所有在线成员。

    与成语接龙的 chain_update 同一套机制：WS 只发「变更了」，客户端收到后重新拉状态，
    避免把整盘菜塞进每一帧消息里。
    """
    room = (await db.execute(select(GroupRoom).where(GroupRoom.id == room_id))).scalar_one_or_none()
    if not room:
        return
    from app.routers.chat import push_group_event
    await push_group_event(db, room_id, room.is_public, {
        "type": "lunch_update",
        "room_id": str(room_id),
        "at": _now().isoformat(),
    })


async def _get_or_create_pool(db: AsyncSession, room_id: uuid.UUID) -> LunchPool:
    today = _today()
    pool = (await db.execute(
        select(LunchPool).where(LunchPool.group_id == room_id, LunchPool.date == today)
    )).scalar_one_or_none()
    if pool:
        return pool
    room = (await db.execute(select(GroupRoom).where(GroupRoom.id == room_id))).scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="群聊不存在")
    pool = LunchPool(
        id=uuid.uuid4(), group_id=room_id, date=today, status="open",
        settings={"freeze_time": "11:30"},
    )
    db.add(pool)
    await db.flush()
    return pool


def _freeze_time(pool: LunchPool) -> time:
    raw = (pool.settings or {}).get("freeze_time") or "11:30"
    try:
        hh, mm = str(raw).split(":")[:2]
        return time(int(hh), int(mm))
    except Exception:
        return time(11, 30)


def _should_auto_freeze(pool: LunchPool) -> bool:
    if pool.status != "open":
        return False
    return _now().time() >= _freeze_time(pool)


async def _ensure_frozen(db: AsyncSession, pool: LunchPool) -> None:
    if _should_auto_freeze(pool):
        pool.status = "frozen"
        pool.freeze_at = utc_now()
        await db.flush()


async def _personal_preset(db: AsyncSession, user_id: uuid.UUID) -> WheelPreset:
    preset = (await db.execute(
        select(WheelPreset).where(
            WheelPreset.owner_type == "user", WheelPreset.owner_id == user_id,
            WheelPreset.name == "默认",
        )
    )).scalar_one_or_none()
    if preset:
        return preset
    preset = WheelPreset(
        id=uuid.uuid4(), owner_type="user", owner_id=user_id, name="默认",
        options=list(DEFAULT_DISHES[:12]), is_default=True,
    )
    db.add(preset)
    await db.flush()
    return preset


def _card_row(card: FoodCard, author: Optional[User], liked: bool) -> dict:
    return {
        "id": str(card.id),
        "dish_names": card.dish_names or [],
        "content": card.content or "",
        "image_urls": card.image_urls or [],
        "meal_type": card.meal_type,
        "source": card.source,
        "like_count": int(card.like_count or 0),
        "comment_count": int(card.comment_count or 0),
        "liked": liked,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "author": {
            "id": str(author.id) if author else "",
            "username": author.username if author else "已注销用户",
            "nickname": (author.nickname or author.username) if author else "已注销用户",
            "avatar_url": (author.avatar_url or "") if author else "",
        },
    }


# ---------------- 美食帖 ----------------

@router.get("/dishes")
async def dish_library(
    q: str = Query("", max_length=32),
    limit: int = Query(8, ge=1, le=30),
    user: User = Depends(get_current_user),
):
    """菜名联想 / 随机换一批：给转盘加菜用，避免用户手打。

    q 为空时随机返回，前端「换一批」直接用；有 q 时优先前缀匹配。
    """
    keyword = (q or "").strip().lower()
    if not keyword:
        items = random.sample(DISH_LIBRARY, min(limit, len(DISH_LIBRARY)))
    else:
        matched = [
            d for d in DISH_LIBRARY
            if keyword in str(d.get("名称", "")).lower()
            or keyword in str(d.get("简短介绍", "")).lower()
        ]
        matched.sort(key=lambda d: (
            not str(d.get("名称", "")).lower().startswith(keyword),
            len(str(d.get("名称", ""))),
        ))
        items = matched[:limit]
    return {"items": items, "total": len(DISH_LIBRARY)}


@router.get("/topic")
async def food_topic(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    post = await _topic(db)
    day_start, day_end = _day_bounds()
    total = int((await db.execute(
        select(func.count()).select_from(FoodCard).where(FoodCard.status == "visible")
    )).scalar() or 0)
    today_count = int((await db.execute(
        select(func.count()).select_from(FoodCard).where(
            FoodCard.status == "visible",
            FoodCard.created_at >= day_start, FoodCard.created_at < day_end,
        )
    )).scalar() or 0)
    return {
        "post_id": str(post.id),
        "title": post.title,
        "description": post.content_md,
        "total_cards": total,
        "today_cards": today_count,
        "quick_comments": QUICK_COMMENTS,
        "my_cards_today": int((await db.execute(
            select(func.count()).select_from(FoodCard).where(
                FoodCard.user_id == user.id,
                FoodCard.status == "visible",
                FoodCard.created_at >= day_start, FoodCard.created_at < day_end,
            )
        )).scalar() or 0),
        "daily_limit": DAILY_CARD_LIMIT,
        "spin_limit": SPIN_CARD_LIMIT,
        "manual_limit": MANUAL_CARD_LIMIT,
        "server_now": _now().isoformat(),
    }


class CardIn(BaseModel):
    content: str = Field("", max_length=300)
    dish_names: list[str] = Field(default_factory=list)
    image_urls: list[str] = Field(default_factory=list)
    meal_type: str = "lunch"
    source: str = "manual"
    group_id: Optional[uuid.UUID] = None


@router.get("/cards")
async def list_cards(
    sort: str = Query("latest", pattern="^(latest|hot)$"),
    meal: str = Query("", max_length=16),
    date: str = Query("", max_length=10),
    page: int = Query(1, ge=1, le=200),
    page_size: int = Query(12, ge=1, le=30),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    post = await _topic(db)
    q = select(FoodCard).where(FoodCard.topic_post_id == post.id, FoodCard.status == "visible")
    if meal in ("breakfast", "lunch", "dinner", "other"):
        q = q.where(FoodCard.meal_type == meal)
    if date:
        try:
            target_day = datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="日期格式不正确")
        day_start = datetime.combine(target_day, time.min, tzinfo=TZ).astimezone(timezone.utc)
        q = q.where(
            FoodCard.created_at >= day_start,
            FoodCard.created_at < day_start + timedelta(days=1),
        )
    if sort == "hot":
        q = q.order_by(FoodCard.like_count.desc(), FoodCard.created_at.desc())
    else:
        q = q.order_by(FoodCard.created_at.desc())
    rows = (await db.execute(q.offset((page - 1) * page_size).limit(page_size + 1))).scalars().all()
    has_more = len(rows) > page_size
    rows = rows[:page_size]

    author_ids = {c.user_id for c in rows}
    authors = {}
    if author_ids:
        for u in (await db.execute(select(User).where(User.id.in_(author_ids)))).scalars().all():
            authors[u.id] = u
    liked = set()
    if rows:
        liked = set((await db.execute(
            select(Like.target_id).where(
                Like.user_id == user.id, Like.target_type == "food_card",
                Like.target_id.in_([c.id for c in rows]),
            )
        )).scalars().all())
    return {
        "items": [_card_row(c, authors.get(c.user_id), c.id in liked) for c in rows],
        "has_more": has_more,
        "page": page,
    }


@router.post("/cards")
async def create_card(
    payload: CardIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    post = await _topic(db)
    day_start, day_end = _day_bounds()
    dishes = [d.strip()[:32] for d in payload.dish_names if d.strip()][:5]
    images = [u for u in payload.image_urls if u][:3]
    if not dishes and not images and not payload.content.strip():
        raise HTTPException(status_code=400, detail="至少写一句话、一道菜或一张图")
    if payload.source not in ("spin", "manual"):
        raise HTTPException(status_code=400, detail="来源不合法")
    if payload.source == "spin":
        # 转盘结果只能晒一次，且必须真的转过一次
        used = int((await db.execute(
            select(func.count()).select_from(FoodCard).where(
                FoodCard.user_id == user.id,
                FoodCard.status == "visible",
                FoodCard.created_at >= day_start, FoodCard.created_at < day_end,
                FoodCard.source == "spin",
            )
        )).scalar() or 0)
        if used >= SPIN_CARD_LIMIT:
            raise HTTPException(status_code=400, detail="今天的转盘卡片已经晒过啦，明天再来")
    else:
        manual = int((await db.execute(
            select(func.count()).select_from(FoodCard).where(
                FoodCard.user_id == user.id,
                FoodCard.status == "visible",
                FoodCard.created_at >= day_start, FoodCard.created_at < day_end,
                FoodCard.source == "manual",
            )
        )).scalar() or 0)
        if manual >= MANUAL_CARD_LIMIT:
            raise HTTPException(
                status_code=400,
                detail=f"今天的手动卡片已经发满 {MANUAL_CARD_LIMIT} 张啦，还能晒 1 张转盘卡",
            )
    total_today = int((await db.execute(
        select(func.count()).select_from(FoodCard).where(
            FoodCard.user_id == user.id,
            FoodCard.status == "visible",
            FoodCard.created_at >= day_start, FoodCard.created_at < day_end,
        )
    )).scalar() or 0)
    if total_today >= DAILY_CARD_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"每天最多发 {DAILY_CARD_LIMIT} 张（转盘 1 张 + 手动 {MANUAL_CARD_LIMIT} 张）",
        )
    if payload.group_id:
        if not await _group_member(db, payload.group_id, user.id):
            raise HTTPException(status_code=403, detail="你不在该群聊中")

    card = FoodCard(
        id=uuid.uuid4(), topic_post_id=post.id, user_id=user.id,
        group_id=payload.group_id,
        dish_names=dishes,
        content=payload.content.strip(),
        image_urls=images,
        meal_type=payload.meal_type if payload.meal_type in ("breakfast", "lunch", "dinner", "other") else "lunch",
        source=payload.source,
    )
    db.add(card)
    await db.commit()
    return {"ok": True, "id": str(card.id)}


@router.get("/cards/{card_id}")
async def card_detail(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    card = (await db.execute(
        select(FoodCard).where(FoodCard.id == card_id, FoodCard.status == "visible")
    )).scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="卡片不存在")
    author = (await db.execute(select(User).where(User.id == card.user_id))).scalar_one_or_none()
    liked = bool((await db.execute(
        select(Like.id).where(
            Like.user_id == user.id, Like.target_type == "food_card", Like.target_id == card.id,
        )
    )).scalar_one_or_none())
    return _card_row(card, author, liked)


@router.post("/comments/{comment_id}/like")
async def toggle_comment_like(
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """给卡片评论点赞 / 取消点赞。"""
    comment = (await db.execute(
        select(FoodCardComment).where(
            FoodCardComment.id == comment_id, FoodCardComment.status == "visible",
        )
    )).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="评论不存在")
    existing = (await db.execute(
        select(Like).where(
            Like.user_id == user.id, Like.target_type == "food_comment", Like.target_id == comment.id,
        )
    )).scalar_one_or_none()
    if existing:
        await db.delete(existing)
        await db.execute(update(FoodCardComment).where(FoodCardComment.id == comment.id)
                         .values(like_count=func.greatest(0, FoodCardComment.like_count - 1)))
        liked = False
    else:
        db.add(Like(user_id=user.id, target_type="food_comment", target_id=comment.id))
        await db.execute(update(FoodCardComment).where(FoodCardComment.id == comment.id)
                         .values(like_count=FoodCardComment.like_count + 1))
        liked = True
    await db.commit()
    count = (await db.execute(
        select(FoodCardComment.like_count).where(FoodCardComment.id == comment.id)
    )).scalar() or 0
    return {"liked": liked, "like_count": int(count)}


@router.delete("/comments/{comment_id}")
async def delete_comment(
    comment_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除自己的评论（管理员可删任意）。保留墓碑，避免下面的跟评失去父节点。"""
    comment = (await db.execute(
        select(FoodCardComment).where(FoodCardComment.id == comment_id)
    )).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="评论不存在")
    if comment.user_id != user.id and user.role not in ("super_admin", "admin"):
        raise HTTPException(status_code=403, detail="只能删除自己的评论")
    if comment.status != "visible":
        return {"ok": True}
    comment.status = "deleted"
    comment.content = ""
    comment.emoji_key = None
    comment.like_count = 0
    await db.execute(update(FoodCard).where(FoodCard.id == comment.card_id)
                     .values(comment_count=func.greatest(0, FoodCard.comment_count - 1)))
    await db.commit()
    return {"ok": True}


@router.post("/cards/{card_id}/like")
async def toggle_like(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    card = (await db.execute(select(FoodCard).where(FoodCard.id == card_id))).scalar_one_or_none()
    if not card or card.status != "visible":
        raise HTTPException(status_code=404, detail="卡片不存在")
    existing = (await db.execute(
        select(Like).where(
            Like.user_id == user.id, Like.target_type == "food_card", Like.target_id == card.id,
        )
    )).scalar_one_or_none()
    if existing:
        await db.delete(existing)
        await db.execute(update(FoodCard).where(FoodCard.id == card.id)
                         .values(like_count=func.greatest(0, FoodCard.like_count - 1)))
        liked = False
    else:
        db.add(Like(user_id=user.id, target_type="food_card", target_id=card.id))
        await db.execute(update(FoodCard).where(FoodCard.id == card.id)
                         .values(like_count=FoodCard.like_count + 1))
        liked = True
        # 接入全站统一通知：卡片作者收到点赞提醒，target_id 指向美食帖，点击直接进入卡片流
        if card.user_id != user.id:
            # 同一个人反复点赞/取消赞不重复堆通知：已有未读的同目标点赞提醒就跳过
            dupe = (await db.execute(
                select(Notification.id).where(
                    Notification.receiver_id == card.user_id,
                    Notification.sender_id == user.id,
                    Notification.action_type == "food_like",
                    Notification.target_id == card.topic_post_id,
                    Notification.is_read.is_(False),
                ).limit(1)
            )).scalar_one_or_none()
            if not dupe:
                db.add(Notification(
                receiver_id=card.user_id,
                sender_id=user.id,
                action_type="food_like",
                target_id=card.topic_post_id,
                brief=f"{user.nickname or user.username} 赞了你的美食卡片",
                ))
    await db.commit()
    count = (await db.execute(select(FoodCard.like_count).where(FoodCard.id == card.id))).scalar() or 0
    return {"liked": liked, "like_count": int(count)}


class CommentIn(BaseModel):
    content: str = Field("", max_length=200)
    emoji_key: Optional[str] = Field(None, max_length=32)
    parent_id: Optional[uuid.UUID] = None


@router.get("/cards/{card_id}/comments")
async def list_comments(
    card_id: uuid.UUID,
    page: int = Query(1, ge=1, le=200),
    page_size: int = Query(30, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """卡片评论：默认按点赞数倒序（同赞按时间），回复里按时间正序由前端排。

    删除的评论保留墓碑（status=deleted），这样它下面的跟评不会变成孤儿。
    """
    rows = (await db.execute(
        select(FoodCardComment).where(
            FoodCardComment.card_id == card_id,
            FoodCardComment.status.in_(["visible", "deleted"]),
        )
        .order_by(FoodCardComment.status.desc(), FoodCardComment.like_count.desc(),
                  FoodCardComment.created_at.desc())
        .offset((page - 1) * page_size).limit(page_size + 1)
    )).scalars().all()
    has_more = len(rows) > page_size
    rows = rows[:page_size]
    authors = {}
    if rows:
        for u in (await db.execute(select(User).where(User.id.in_({r.user_id for r in rows})))).scalars().all():
            authors[u.id] = u
    liked = set()
    if rows:
        liked = set((await db.execute(
            select(Like.target_id).where(
                Like.user_id == user.id, Like.target_type == "food_comment",
                Like.target_id.in_([r.id for r in rows]),
            )
        )).scalars().all())
    return {
        "items": [{
            "id": str(r.id),
            "content": r.content,
            "emoji_key": r.emoji_key,
            "parent_id": str(r.parent_id) if r.parent_id else None,
            "like_count": int(r.like_count or 0),
            "liked": r.id in liked,
            "status": r.status,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "author": {
                "username": authors[r.user_id].username if r.user_id in authors else "已注销用户",
                "nickname": (authors[r.user_id].nickname or authors[r.user_id].username)
                            if r.user_id in authors else "已注销用户",
                "avatar_url": (authors[r.user_id].avatar_url or "") if r.user_id in authors else "",
            },
        } for r in rows],
        "has_more": has_more,
    }


@router.post("/cards/{card_id}/comments")
async def create_comment(
    card_id: uuid.UUID,
    payload: CommentIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    card = (await db.execute(select(FoodCard).where(FoodCard.id == card_id))).scalar_one_or_none()
    if not card or card.status != "visible":
        raise HTTPException(status_code=404, detail="卡片不存在")
    parent = None
    if payload.parent_id:
        parent = (await db.execute(
            select(FoodCardComment).where(
                FoodCardComment.id == payload.parent_id,
                FoodCardComment.card_id == card.id,
                FoodCardComment.status == "visible",
            )
        )).scalar_one_or_none()
        if not parent:
            raise HTTPException(status_code=400, detail="回复的评论不存在或已删除")

    text = payload.content.strip()
    if payload.emoji_key and payload.emoji_key not in {q["emoji"] for q in QUICK_COMMENTS}:
        raise HTTPException(status_code=400, detail="表情不可用")
    if not text and not payload.emoji_key:
        raise HTTPException(status_code=400, detail="说点什么吧")
    if text:
        from app.services.sensitive_service import sensitive_filter
        blocked, _, clean = sensitive_filter.scan(text)
        if blocked:
            raise HTTPException(status_code=400, detail="评论包含违规内容")
        text = clean
    comment = FoodCardComment(
        id=uuid.uuid4(), card_id=card.id, user_id=user.id,
        parent_id=payload.parent_id, content=text, emoji_key=payload.emoji_key,
    )
    db.add(comment)
    await db.execute(update(FoodCard).where(FoodCard.id == card.id)
                     .values(comment_count=FoodCard.comment_count + 1))

    sender_name = user.nickname or user.username
    dish_label = (card.dish_names or [""])[0] if card.dish_names else ""
    if card.user_id != user.id:
        db.add(Notification(
            receiver_id=card.user_id,
            sender_id=user.id,
            action_type="food_comment",
            target_id=card.topic_post_id,
            brief=f"{sender_name} 评论了你的美食卡片{f'「{dish_label}」' if dish_label else ''}",
        ))
    if parent and parent.user_id not in (user.id, card.user_id):
        db.add(Notification(
            receiver_id=parent.user_id,
            sender_id=user.id,
            action_type="food_reply",
            target_id=card.topic_post_id,
            brief=f"{sender_name} 回复了你在美食帖下的评论",
        ))

    await db.commit()
    return {"ok": True, "id": str(comment.id)}


@router.delete("/cards/{card_id}")
async def delete_card(
    card_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    card = (await db.execute(select(FoodCard).where(FoodCard.id == card_id))).scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="卡片不存在")
    if card.user_id != user.id and user.role not in ("super_admin", "admin"):
        raise HTTPException(status_code=403, detail="只能删除自己的卡片")
    card.status = "deleted"
    await db.commit()
    return {"ok": True}


# ---------------- 午餐转盘 ----------------

class PresetIn(BaseModel):
    options: list[str] = Field(default_factory=list)


class DishIn(BaseModel):
    name: str = Field(..., max_length=32)


class FreezeIn(BaseModel):
    freeze_time: str = Field(..., pattern=r"^\d{2}:\d{2}$")


@router.get("/wheel")
async def wheel_state(
    group_id: Optional[uuid.UUID] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    preset = await _personal_preset(db, user.id)
    data: dict[str, Any] = {
        "personal": {"options": preset.options or list(DEFAULT_DISHES[:12]), "limit": 20},
        "server_now": _now().isoformat(),
        "spin_limit": SPIN_LIMIT,
        "dish_per_user": DISH_PER_USER,
        # 超管：即使不是群成员也能进盘测试；前端据此显示「测试模式」
        "is_super_admin": user.role == "super_admin",
    }
    if group_id:
        member = await _group_member(db, group_id, user.id)
        if not member and user.role != "super_admin":
            raise HTTPException(status_code=403, detail="只有群成员才能参与本群午餐盘")
        pool = await _get_or_create_pool(db, group_id)
        await _ensure_frozen(db, pool)
        dishes = (await db.execute(
            select(LunchDish).where(LunchDish.pool_id == pool.id).order_by(LunchDish.created_at.asc())
        )).scalars().all()
        mine = [d for d in dishes if d.user_id == user.id]
        spins = int((await db.execute(
            select(func.count()).select_from(LunchSpin).where(
                LunchSpin.pool_id == pool.id, LunchSpin.user_id == user.id,
            )
        )).scalar() or 0)
        count = await _member_count(db, group_id)
        data["group"] = {
            "pool_id": str(pool.id),
            "status": pool.status,
            "freeze_time": (pool.settings or {}).get("freeze_time", "11:30"),
            "cap": _pool_cap(count),
            "dishes": [{"id": str(d.id), "name": d.name, "mine": d.user_id == user.id} for d in dishes],
            "my_count": len(mine),
            "spin_used": spins,
            "spin_left": max(0, SPIN_LIMIT - spins),
            "can_manage": _can_manage(member, user),
            "member_count": count,
        }
        await db.commit()
    return data


@router.put("/wheel/personal")
async def save_personal(
    payload: PresetIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    opts = []
    for raw in payload.options:
        name = str(raw).strip()[:20]
        if name and name not in opts:
            opts.append(name)
    if len(opts) < 2:
        raise HTTPException(status_code=400, detail="至少保留 2 道菜")
    if len(opts) > 20:
        raise HTTPException(status_code=400, detail="最多 20 道菜")
    preset = await _personal_preset(db, user.id)
    preset.options = opts
    await db.commit()
    return {"ok": True, "options": opts}


@router.post("/wheel/spin")
async def spin(
    group_id: Optional[uuid.UUID] = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not group_id:
        preset = await _personal_preset(db, user.id)
        opts = preset.options or list(DEFAULT_DISHES[:12])
        dish = secrets.choice(opts)
        return {
            "ok": True, "dish": dish, "index": opts.index(dish), "options": opts,
            "message": _warm_word(), "source": "personal",
            "intro": _dish_intro(dish),
        }

    member = await _group_member(db, group_id, user.id)
    if not member and user.role != "super_admin":
        raise HTTPException(status_code=403, detail="只有群成员才能转本群午餐盘")
    pool = await _get_or_create_pool(db, group_id)
    await _ensure_frozen(db, pool)
    spins = int((await db.execute(
        select(func.count()).select_from(LunchSpin).where(
            LunchSpin.pool_id == pool.id, LunchSpin.user_id == user.id,
        )
    )).scalar() or 0)
    if spins >= SPIN_LIMIT:
        raise HTTPException(status_code=400, detail=f"今天已经转过 {SPIN_LIMIT} 次啦，明天再来")
    dishes = (await db.execute(
        select(LunchDish).where(LunchDish.pool_id == pool.id).order_by(LunchDish.created_at.asc())
    )).scalars().all()
    if not dishes:
        raise HTTPException(status_code=400, detail="今天的菜盘还是空的，先加几道菜吧")
    # 冻结只由设定时间触发；不能因为有人先转了一次就把整个群盘锁死，
    # 否则「有人先转了、其他人还没加菜」就再也加不进去。
    dish = secrets.choice(dishes)
    db.add(LunchSpin(id=uuid.uuid4(), pool_id=pool.id, user_id=user.id, dish_id=dish.id))
    await db.commit()
    return {
        "ok": True,
        "dish": dish.name,
        "index": [d.name for d in dishes].index(dish.name),
        "options": [d.name for d in dishes],
        "message": _warm_word(str(dish.id)),
        "intro": _dish_intro(dish.name),
        "source": "group",
        "spin_left": max(0, SPIN_LIMIT - spins - 1),
        "pool_status": pool.status,
    }


@router.post("/wheel/group/{group_id}/dishes")
async def add_dish(
    group_id: uuid.UUID,
    payload: DishIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    member = await _group_member(db, group_id, user.id)
    if not member and user.role != "super_admin":
        raise HTTPException(status_code=403, detail="只有群成员才能加菜")
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="菜名至少 2 个字")
    from app.services.sensitive_service import sensitive_filter
    blocked, _, clean = sensitive_filter.scan(name)
    if blocked:
        raise HTTPException(status_code=400, detail="菜名包含违规内容")
    name = clean[:32]
    pool = await _get_or_create_pool(db, group_id)
    await _ensure_frozen(db, pool)
    if pool.status == "frozen":
        raise HTTPException(status_code=400, detail="今天的菜盘已冻结，明天再来加菜吧")
    mine = int((await db.execute(
        select(func.count()).select_from(LunchDish).where(
            LunchDish.pool_id == pool.id, LunchDish.user_id == user.id,
        )
    )).scalar() or 0)
    if mine >= DISH_PER_USER:
        raise HTTPException(status_code=400, detail=f"每人每天最多贡献 {DISH_PER_USER} 道菜")
    total = int((await db.execute(
        select(func.count()).select_from(LunchDish).where(LunchDish.pool_id == pool.id)
    )).scalar() or 0)
    if total >= _pool_cap(await _member_count(db, group_id)):
        raise HTTPException(status_code=400, detail="今天的菜盘满了，明天早点来")
    exists = (await db.execute(
        select(LunchDish.id).where(LunchDish.pool_id == pool.id, LunchDish.norm_name == _norm(name))
    )).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=400, detail="这道菜已经在盘子里了")
    db.add(LunchDish(id=uuid.uuid4(), pool_id=pool.id, user_id=user.id, name=name, norm_name=_norm(name)))
    await db.commit()
    await _push_lunch_update(db, group_id)
    return {"ok": True, "name": name}


@router.delete("/wheel/group/{group_id}/dishes/{dish_id}")
async def remove_dish(
    group_id: uuid.UUID,
    dish_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dish = (await db.execute(select(LunchDish).where(LunchDish.id == dish_id))).scalar_one_or_none()
    if not dish:
        raise HTTPException(status_code=404, detail="菜不存在")
    pool = (await db.execute(select(LunchPool).where(LunchPool.id == dish.pool_id))).scalar_one_or_none()
    if not pool or pool.group_id != group_id:
        raise HTTPException(status_code=404, detail="菜不存在")
    member = await _group_member(db, group_id, user.id)
    if dish.user_id != user.id and not _can_manage(member, user):
        raise HTTPException(status_code=403, detail="只能删除自己加的菜")
    if pool.status == "frozen":
        raise HTTPException(status_code=400, detail="菜盘已冻结，不能再改")
    await db.delete(dish)
    await db.commit()
    await _push_lunch_update(db, group_id)
    return {"ok": True}


@router.post("/wheel/group/{group_id}/test-reset")
async def test_reset_pool(
    group_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """超管测试用：清空本群今日菜盘并重新开放，冻结时间临时改到 23:59。

    仅 super_admin 可用；用于在非午餐时段验证「加菜 → 冻结 → 转盘 → 晒卡」链路。
    """
    if user.role != "super_admin":
        raise HTTPException(status_code=403, detail="仅超级管理员可重置测试菜盘")
    room = (await db.execute(select(GroupRoom).where(GroupRoom.id == group_id))).scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=404, detail="群聊不存在")
    old = (await db.execute(
        select(LunchPool).where(LunchPool.group_id == group_id, LunchPool.date == _today())
    )).scalar_one_or_none()
    if old:
        await db.delete(old)
        await db.flush()
    pool = LunchPool(
        id=uuid.uuid4(), group_id=group_id, date=_today(), status="open",
        settings={"freeze_time": "23:59"},
    )
    db.add(pool)
    await db.commit()
    await _push_lunch_update(db, group_id)
    return {"ok": True, "pool_id": str(pool.id), "status": "open", "freeze_time": "23:59"}


@router.put("/wheel/group/{group_id}/settings")
async def update_settings(
    group_id: uuid.UUID,
    payload: FreezeIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    member = await _group_member(db, group_id, user.id)
    if not _can_manage(member, user):
        raise HTTPException(status_code=403, detail="只有群主/管理员可以修改冻结时间")
    try:
        hh, mm = payload.freeze_time.split(":")
        value = time(int(hh), int(mm))
    except Exception:
        raise HTTPException(status_code=400, detail="时间格式不正确")
    if not (time(10, 0) <= value <= time(14, 0)):
        raise HTTPException(status_code=400, detail="冻结时间需在 10:00–14:00 之间")
    pool = await _get_or_create_pool(db, group_id)
    settings = dict(pool.settings or {})
    settings["freeze_time"] = payload.freeze_time
    pool.settings = settings
    await db.commit()
    await _push_lunch_update(db, group_id)
    return {"ok": True, "freeze_time": payload.freeze_time, "status": pool.status}
