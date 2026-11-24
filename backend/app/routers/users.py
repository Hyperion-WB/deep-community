import math
from datetime import date, timedelta, datetime, timezone
from uuid import UUID
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, or_, and_, delete, update
from sqlalchemy.exc import IntegrityError
from typing import List, Optional
from pydantic import BaseModel, Field
from app.core.database import get_db, get_redis
from app.core.config import settings
from app.services.user_deletion import request_user_deletion
from app.models.user import User
from app.models.achievement import AchievementDef, UserAchievement
from app.models.user import User, Checkin, Follow, UserBlock, InviteCode, UserSession
from app.models.post import Post, Collection
from app.models.comment import Comment
from app.models.system import Notification
from app.schemas.user import (
    CheckinResponse, UserProfileResponse, UserUpdateRequest,
    PasswordChangeRequest, DeactivateRequest, BlockedUserItem, DndUpdateRequest,
    PrivacyUpdateRequest, FollowUserItem, FollowListResponse, BindEmailRequest, SessionItem,
    PortalModeUpdateRequest
)
from app.services.email_code_service import verify_code
from app.services.session_service import get_session, revoke_session
from app.core.security import decode_token
from app.schemas.post import PostSimpleResponse
from app.routers.deps import get_current_user, get_current_user_optional
from app.services.level_service import add_user_experience, record_user_activity
from app.services.image_service import save_upload_image
from app.routers.posts import extract_toc_and_reading_time, smart_extract_title_from_md
from app.core.security import verify_password_async, get_password_hash_async
from app.core.timezone import format_utc_iso

router = APIRouter(prefix="/users", tags=["用户与成长"])

# 连续签到里程碑：达成即 +1 次补签机会
MAKEUP_MILESTONES = [5, 10, 15, 25]


def _peak_real_streak_in_month(dates, makeup_dates, month_start) -> int:
    """当月内达到过的「真实连续签到」最高天数。

    补签日不计入连签奖励：先剔除补签日期，再按真实日期重算连续段；
    跨月的连续段保留累计（例如上月已连 20 天，本月第 1 天就记为 20）。
    """
    real = [d for d in dates if d not in makeup_dates]
    peak = 0
    run = 0
    prev = None
    for d in real:
        run = run + 1 if prev is not None and d == prev + timedelta(days=1) else 1
        prev = d
        if d >= month_start and run > peak:
            peak = run
    return peak


async def _makeup_quota(db: AsyncSession, user_id) -> tuple[int, int, int]:
    """返回 (本月可获得, 本月已使用, 本月剩余) 补签卡。

    - 奖励按「真实签到」的连签里程碑计算，补签日不计入；
    - 额度按自然月重置：每月 1 号重新计算可获得张数，已用量只统计本月消耗的卡。
    """
    from sqlalchemy import text

    rows = (await db.execute(
        text("SELECT target_date, created_at FROM checkin_makeups WHERE user_id = :uid"),
        {"uid": str(user_id)},
    )).all()
    makeup_dates = {r[0] for r in rows}
    dates = (await db.execute(
        select(Checkin.checkin_date)
        .where(Checkin.user_id == user_id)
        .order_by(Checkin.checkin_date.asc())
    )).scalars().all()

    today = date.today()
    month_start = today.replace(day=1)
    peak = _peak_real_streak_in_month(dates, makeup_dates, month_start)
    earned = sum(1 for m in MAKEUP_MILESTONES if peak >= m)

    # 本月消耗的卡按「使用时间」统计，而不是补签的目标日期：
    # 本月补签上个月的漏签，也应该扣本月的额度。
    tz = datetime.now().astimezone().tzinfo
    month_start_utc = datetime(month_start.year, month_start.month, 1, tzinfo=tz).astimezone(timezone.utc)
    used = 0
    for _target, created in rows:
        if not created:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created.astimezone(timezone.utc) >= month_start_utc:
            used += 1
    return earned, used, max(0, earned - used)


def _nickname_change_remaining(user: User) -> int:
    """本月剩余可改昵称次数（含管理员在用户管理页重置后额外发放的额度）。"""
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    if user.nickname_last_change_month != current_month:
        natural = 3
    else:
        natural = max(0, 3 - (user.nickname_change_count or 0))
    return natural + max(0, int(getattr(user, "nickname_extra_quota", 0) or 0))


async def _current_streak(db: AsyncSession, user_id) -> int:
    """当前连续签到天数。

    必须校验最后一条签到是不是今天/昨天：否则一个两个月前连续 10 天的用户，
    页面上会一直显示「连续 10 天」，数据是错的。
    """
    rows = (await db.execute(
        select(Checkin.checkin_date)
        .where(Checkin.user_id == user_id)
        .order_by(Checkin.checkin_date.desc())
        .limit(400)
    )).scalars().all()
    if not rows:
        return 0
    today = date.today()
    if rows[0] not in (today, today - timedelta(days=1)):
        return 0
    cursor = rows[0]
    days = 0
    for d in rows:
        if d == cursor:
            days += 1
            cursor -= timedelta(days=1)
        elif d < cursor:
            break
    return days


async def _recompute_continuous_days(db: AsyncSession, user_id, start: date) -> None:
    """从 start 起重算 continuous_days 连续链。

    补签是往历史里插一天，后面已有的记录必须跟着修正，否则会出现
    「补签了昨天，今天签到仍然只有连续 1 天」或连续天数倒退。
    """
    prev = (await db.execute(
        select(Checkin.checkin_date, Checkin.continuous_days)
        .where(Checkin.user_id == user_id, Checkin.checkin_date < start)
        .order_by(Checkin.checkin_date.desc())
        .limit(1)
    )).first()
    streak = int(prev[1]) if prev else 0
    last_date = prev[0] if prev else None

    rows = (await db.execute(
        select(Checkin)
        .where(Checkin.user_id == user_id, Checkin.checkin_date >= start)
        .order_by(Checkin.checkin_date.asc())
    )).scalars().all()
    for row in rows:
        if last_date and row.checkin_date == last_date + timedelta(days=1):
            streak += 1
        else:
            streak = 1
        if row.continuous_days != streak:
            row.continuous_days = streak
        last_date = row.checkin_date


@router.get("/staff")
async def list_staff(db: AsyncSession = Depends(get_db)):
    """常驻工作人员：超级管理员 / 管理员（版主）/ 审计员。

    极客探索页用它做「常驻卡片」，方便普通用户直接找到人联系。
    """
    rows = (await db.execute(
        select(User).where(
            User.role.in_(["super_admin", "admin", "moderator", "auditor"]),
            User.status != "banned",
        ).order_by(User.role.asc(), User.level.desc()).limit(30)
    )).scalars().all()
    order = {"super_admin": 0, "admin": 1, "moderator": 2, "auditor": 3}
    items = sorted(rows, key=lambda u: (order.get(u.role, 9), -(u.level or 0)))
    return [
        {
            "username": u.username,
            "nickname": u.nickname,
            "avatar_url": u.avatar_url or "",
            "level": u.level,
            "role": u.role,
            # moderator 是「版主」，和审计员(auditor)不是一回事，不能混用文案
            "role_label": {
                "super_admin": "超级管理员",
                "admin": "管理员",
                "moderator": "版主",
                "auditor": "审计员",
            }.get(u.role, u.role),
            "is_online": bool(getattr(u, "is_online", False)),
        }
        for u in items
    ]


@router.get("/checkin/status")
async def checkin_status(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """签到状态：连续天数、今日是否已签、剩余补签次数。"""
    today = date.today()
    has_today = (await db.execute(
        select(Checkin.id).where(Checkin.user_id == user.id, Checkin.checkin_date == today)
    )).scalar_one_or_none() is not None
    streak = await _current_streak(db, user.id)
    best = (await db.execute(
        select(func.max(Checkin.continuous_days)).where(Checkin.user_id == user.id)
    )).scalar() or 0
    earned, used, left = await _makeup_quota(db, user.id)
    # 注册日期按服务器本地时区取整：热力图/签到日期都是本地日期，混用 UTC 会差一天
    created = user.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    registered_date = created.astimezone().date() if created else today
    return {
        "checked_today": has_today,
        "streak": int(streak),
        "best_streak": int(best),
        "makeup_earned": earned,
        "makeup_used": used,
        "makeup_left": left,
        # 额度按月重置：前端据此显示「YYYY-MM 额度」，跨月自动变成新月份
        "makeup_period": today.strftime("%Y-%m"),
        "milestones": MAKEUP_MILESTONES,
        # 补签边界：注册之前没有「漏签」概念，前端据此禁用不可补的日期
        "makeup_since": max(registered_date, today - timedelta(days=180)).isoformat(),
        "makeup_until": (today - timedelta(days=1)).isoformat(),
    }


@router.post("/checkin/makeup")
async def checkin_makeup(
    payload: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """补签指定日期：消耗一次补签机会。"""
    from sqlalchemy import text

    raw = (payload or {}).get("date") or ""
    try:
        target = date.fromisoformat(str(raw))
    except Exception:
        raise HTTPException(status_code=400, detail="日期格式不正确")

    today = date.today()
    if target >= today:
        raise HTTPException(status_code=400, detail="只能补签今天之前的日期")
    if target < today - timedelta(days=180):
        raise HTTPException(status_code=400, detail="只能补签半年内的日期")
    # 注册之前没有「漏签」概念，允许补只会造出虚假的连续记录
    created = user.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    registered = created.astimezone().date() if created else None
    if registered and target < registered:
        raise HTTPException(status_code=400, detail="只能补签注册之后的日期")

    # 串行化同一用户的补签请求：否则两个不同日期并发补签会都读到「剩 1 张」，
    # 一张卡被用出两次（双花）。锁住用户行，后到的请求等前一个提交后重新计算额度。
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())

    exists = (await db.execute(
        select(Checkin.id).where(Checkin.user_id == user.id, Checkin.checkin_date == target)
    )).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=400, detail="这天已经签过了")

    _earned, _used, left = await _makeup_quota(db, user.id)
    if left <= 0:
        raise HTTPException(
            status_code=400,
            detail="补签机会不足：连续签到 5 / 10 / 15 / 25 天各可获得一次",
        )

    db.add(Checkin(user_id=user.id, checkin_date=target, continuous_days=1))
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="这天已经签过了")

    await db.execute(
        text(
            "INSERT INTO checkin_makeups (user_id, target_date) VALUES (:uid, :d) "
            "ON CONFLICT (user_id, target_date) DO NOTHING"
        ),
        {"uid": str(user.id), "d": target},
    )
    # 补签改变了历史链条：重算从该日期起的连续天数，接口返回最新连击
    await _recompute_continuous_days(db, user.id, target)
    await db.commit()

    _e2, _u2, left2 = await _makeup_quota(db, user.id)
    streak = await _current_streak(db, user.id)
    best = (await db.execute(
        select(func.max(Checkin.continuous_days)).where(Checkin.user_id == user.id)
    )).scalar() or 0
    return {
        "ok": True,
        "date": target.isoformat(),
        "makeup_left": left2,
        "streak": int(streak),
        "best_streak": int(best),
    }


@router.post("/checkin", response_model=CheckinResponse)
async def checkin(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    today = date.today()
    
    # 检查今日是否已签到
    query = select(Checkin).where(Checkin.user_id == user.id, Checkin.checkin_date == today)
    res = await db.execute(query)
    if res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="今日已经完成签到打卡")

    # 检查昨天是否签到以计算连续天数
    yesterday = today - timedelta(days=1)
    yest_query = select(Checkin).where(Checkin.user_id == user.id, Checkin.checkin_date == yesterday)
    yest_res = await db.execute(yest_query)
    yest_checkin = yest_res.scalar_one_or_none()

    continuous = (yest_checkin.continuous_days + 1) if yest_checkin else 1

    # 签到经验奖励: 基础 5 点，连续满 7 天额外 +15 点
    exp_gain = 5
    if continuous % 7 == 0:
        exp_gain += 15

    new_checkin = Checkin(
        user_id=user.id,
        checkin_date=today,
        continuous_days=continuous
    )
    db.add(new_checkin)
    try:
        await db.flush()
    except IntegrityError:
        # 并发重复签到：唯一约束兜底
        await db.rollback()
        raise HTTPException(status_code=400, detail="今日已经完成签到打卡")
    # 签到记录必须先独立提交：经验接口在配额用尽时会提前 return 且不再 commit
    await db.commit()
    await db.refresh(user)

    # 计入活跃天数与经验提升（服务层只 flush，提交由这里统一负责）
    await record_user_activity(user, db)
    current_level = await add_user_experience(user, exp_gain, db)
    await db.commit()

    return CheckinResponse(
        success=True,
        continuous_days=continuous,
        exp_gained=exp_gain,
        current_level=current_level
    )

@router.post("/me/avatar")
async def update_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    url, _ = await save_upload_image(file, str(user.id), is_avatar=True)
    user.avatar_url = url
    await db.commit()
    return {"avatar_url": url}

async def _online_user_ids(user_ids) -> set:
    """批量判断在线（deps 层 90 秒心跳键）。

    用 pipeline 一次往返取全部结果，避免列表里 N 个用户发 N 次 Redis 请求。
    Redis 不可用时返回空集（全员显示离线，不影响页面可用性）。
    """
    ids = [uid for uid in user_ids if uid]
    if not ids:
        return set()
    try:
        redis = get_redis()
        if not redis:
            return set()
        pipe = redis.pipeline()
        for uid in ids:
            pipe.exists(f"online:user:{uid}")
        flags = await pipe.execute()
        return {uid for uid, flag in zip(ids, flags) if flag}
    except Exception:
        return set()


@router.get("/search", response_model=List[FollowUserItem])
async def search_users(
    q: str = Query("", min_length=1),
    limit: int = Query(20, ge=1, le=50),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    keyword = q.strip()
    clean_q = f"%{keyword}%"
    # 多取一些候选再打分排序：用户名/昵称/bio 三种命中混在一起时，
    # 直接按数据库返回顺序截断会让"用户名精确命中"排在"简介包含"后面
    stmt = select(User).where(
        User.status.not_in(("banned", "deactivated", "deleting")),
        or_(
            User.username.ilike(clean_q),
            User.nickname.ilike(clean_q),
            User.bio.ilike(clean_q)
        )
    ).limit(max(limit * 3, 30))
    res = await db.execute(stmt)
    users = res.scalars().all()

    lowered = keyword.lower()

    def _score(u: User) -> tuple[int, str]:
        """命中权重：用户名精确 > 用户名前缀 > 昵称精确 > 昵称前缀 > 昵称包含 > bio。
        用户名是唯一标识，所以它永远排在昵称前面——A 的账号与 B 的昵称同名时不会互相盖住。"""
        name = (u.username or "").lower()
        nick = (u.nickname or "").lower()
        bio = (u.bio or "").lower()
        if name == lowered:
            return 100, "username"
        if name.startswith(lowered):
            return 80, "username"
        if nick == lowered:
            return 70, "nickname"
        if nick.startswith(lowered):
            return 60, "nickname"
        if lowered and lowered in nick:
            return 40, "nickname"
        if lowered and lowered in name:
            return 35, "username"
        if lowered and lowered in bio:
            return 10, "bio"
        return 0, ""

    scored = [(_score(u), u) for u in users]
    scored.sort(key=lambda pair: (-pair[0][0], (pair[1].username or "").lower()))
    users = [u for _, u in scored[:limit]]

    following_set = set()
    if current_user and users:
        target_ids = [u.id for u in users]
        f_res = await db.execute(select(Follow.following_id).where(Follow.follower_id == current_user.id, Follow.following_id.in_(target_ids)))
        following_set = set(f_res.scalars().all())

    online_ids = await _online_user_ids([u.id for u in users])

    items = []
    for u in users:
        f_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.following_id == u.id))).scalar_one()
        fol_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.follower_id == u.id))).scalar_one()
        _, match_type = _score(u)
        items.append(FollowUserItem(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            avatar_url=u.avatar_url,
            bio=u.bio or "",
            level=u.level,
            role=u.role,
            followers_count=f_cnt,
            following_count=fol_cnt,
            is_following=(u.id in following_set),
            match_type=match_type,
        ))
    return items

@router.get("/me/portal")
async def get_portal_mode(current_user: User = Depends(get_current_user)):
    """读取账号级默认门户界面（默认经典版）。"""
    mode = str(getattr(current_user, "portal_mode", "classic") or "classic")
    return {"portal_mode": mode if mode in ("classic", "pro") else "classic"}


@router.put("/me/portal")
async def update_portal_mode(
    req: PortalModeUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """设置默认门户界面，写入 users 表长期保存（换设备 / 重新登录仍生效）。"""
    current_user.portal_mode = req.portal_mode
    await db.commit()
    await db.refresh(current_user)
    return {"ok": True, "portal_mode": current_user.portal_mode}


@router.put("/me/privacy", response_model=UserProfileResponse)
async def update_privacy(
    req: PrivacyUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if req.hide_following is not None:
        current_user.hide_following = req.hide_following
    if req.hide_followers is not None:
        current_user.hide_followers = req.hide_followers
    if req.hide_favorites is not None:
        current_user.hide_favorites = req.hide_favorites
    if req.hide_ip_location is not None:
        current_user.hide_ip_location = req.hide_ip_location
    if req.open_post_in_new_tab is not None:
        current_user.open_post_in_new_tab = bool(req.open_post_in_new_tab)
    if req.hide_online_status is not None:
        current_user.hide_online_status = req.hide_online_status
    if req.dnd_enabled is not None:
        current_user.dnd_enabled = req.dnd_enabled
    await db.commit()
    await db.refresh(current_user)
    return await get_public_profile(current_user.username, current_user, db)

@router.get("/profile/{username}", response_model=UserProfileResponse)
async def get_public_profile(
    username: str,
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    query = select(User).where(User.username == username)
    res = await db.execute(query)
    target = res.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="未找到该用户")

    # 注销缓冲期内的账号对外不可见；管理员与本人仍可查看，便于处理后续事务
    if target.status == "deleting":
        privileged = current_user is not None and (
            current_user.id == target.id
            or current_user.role in ("super_admin", "admin", "moderator")
        )
        if not privileged:
            raise HTTPException(status_code=404, detail="未找到该用户")

    remaining_changes = _nickname_change_remaining(target)

    # 计算粉丝数、关注数、公开文章数
    # 计数口径与关注/粉丝列表一致：排除已封禁账号，避免"粉丝 100 点开只有 95"的矛盾
    followers_cnt = (await db.execute(
        select(func.count()).select_from(Follow)
        .join(User, Follow.follower_id == User.id)
        .where(Follow.following_id == target.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )).scalar_one()
    following_cnt = (await db.execute(
        select(func.count()).select_from(Follow)
        .join(User, Follow.following_id == User.id)
        .where(Follow.follower_id == target.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )).scalar_one()
    posts_cnt = (await db.execute(select(func.count()).select_from(Post).where(Post.author_id == target.id, Post.status == "published"))).scalar_one()

    is_following = False
    is_blocked = False
    is_blocked_by = False

    if current_user and current_user.id != target.id:
        # 我是否关注了他
        f_res = await db.execute(select(Follow).where(Follow.follower_id == current_user.id, Follow.following_id == target.id))
        is_following = f_res.scalar_one_or_none() is not None

        # 我是否拉黑了他
        b_res = await db.execute(select(UserBlock).where(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target.id))
        is_blocked = b_res.scalar_one_or_none() is not None

        # 他是否拉黑了我
        by_res = await db.execute(select(UserBlock).where(UserBlock.blocker_id == target.id, UserBlock.blocked_id == current_user.id))
        is_blocked_by = by_res.scalar_one_or_none() is not None

    today = date.today()
    checkin_res = await db.execute(select(Checkin.id).where(Checkin.user_id == target.id, Checkin.checkin_date == today))
    has_checked_in = checkin_res.scalar_one_or_none() is not None

    last_checkin_days = await _current_streak(db, target.id)

    likes_cnt = (await db.execute(
        select(func.coalesce(func.sum(Post.like_count), 0)).where(Post.author_id == target.id, Post.status == "published")
    )).scalar_one_or_none() or 0

    comments_cnt = (await db.execute(
        select(func.count(Comment.id)).where(Comment.author_id == target.id, Comment.status != "deleted")
    )).scalar_one_or_none() or 0

    # 公开主页只暴露展示所需字段：注册渠道、强制改密标记、剩余配额、免打扰设置
    # 都属于账号内部状态，非本人查看时一律不下发
    is_self = bool(current_user and current_user.id == target.id)

    # 在线状态：依赖 deps 层 90 秒心跳键。用户开启「隐藏在线状态」后，
    # 他人看到的恒为离线（显示"已隐藏"本身也会泄露信息，所以统一表现为离线）
    target_online = False
    try:
        redis = get_redis()
        if redis:
            target_online = bool(await redis.exists(f"online:user:{target.id}"))
    except Exception:
        target_online = False
    if getattr(target, "hide_online_status", False) and not is_self:
        target_online = False

    return UserProfileResponse(
        id=target.id,
        username=target.username,
        nickname=target.nickname,
        email=target.email if is_self else "***@***.com",
        avatar_url=target.avatar_url,
        bio=target.bio if not is_blocked_by else "由于对方的隐私限制，主页已受保护",
        role=target.role,
        status=target.status,
        level=target.level,
        experience=target.experience,
        active_days=target.active_days,
        created_at=target.created_at,
        remaining_anon_quota=0,
        remaining_nickname_changes=remaining_changes if is_self else 0,
        followers_count=followers_cnt,
        following_count=following_cnt,
        posts_count=posts_cnt,
        is_following=is_following,
        is_blocked=is_blocked,
        is_blocked_by=is_blocked_by,
        dnd_enabled=bool(target.dnd_enabled) if is_self else False,
        hide_following=bool(target.hide_following),
        hide_followers=bool(target.hide_followers),
        hide_favorites=bool(target.hide_favorites),
        hide_ip_location=bool(getattr(target, "hide_ip_location", False)),
        hide_online_status=bool(getattr(target, "hide_online_status", False)),
        open_post_in_new_tab=bool(getattr(target, "open_post_in_new_tab", False)) if is_self else False,
        portal_mode=(str(getattr(target, "portal_mode", "classic") or "classic") if is_self else "classic"),
        is_online=target_online,
        has_checked_in_today=has_checked_in,
        equipped_title=target.equipped_title,
        continuous_checkin_days=last_checkin_days,
        likes_received_count=int(likes_cnt),
        comments_count=int(comments_cnt),
        gender=getattr(target, "gender", "secret") or "secret",
        tech_stack=getattr(target, "tech_stack", "") or "",
        github_url=getattr(target, "github_url", "") or "",
        blog_url=getattr(target, "blog_url", "") or "",
        # 属地属于可隐藏信息：用户开启后仅自己可见
        ip_location=""
        if (getattr(target, "hide_ip_location", False) and not is_self)
        else (getattr(target, "ip_location", "") or ""),
        # 邮箱验证与第三方绑定状态仅本人可见
        email_verified=bool(getattr(target, "email_verified", False)) if is_self else False,
        github_bound=bool(getattr(target, "github_id", None)) if is_self else False,
        gitee_bound=bool(getattr(target, "gitee_id", None)) if is_self else False,
        # 注册渠道与强制改密标记属于账号内部状态，仅本人可见
        register_channel=(getattr(target, "register_channel", "public") or "public") if is_self else "",
        must_change_password=bool(getattr(target, "must_change_password", False)) if is_self else False,
    )

@router.put("/me", response_model=UserProfileResponse)
async def update_profile(
    req: UserUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    # 月度重置校验
    if user.nickname_last_change_month != current_month:
        user.nickname_change_count = 0
        user.nickname_last_change_month = current_month

    if req.nickname is not None:
        new_nick = req.nickname.strip()
        # 仅当昵称确实产生变化时消耗额度
        if new_nick and new_nick != (user.nickname or ""):
            extra_quota = max(0, int(getattr(user, "nickname_extra_quota", 0) or 0))
            if (user.nickname_change_count or 0) < 3:
                # 优先消耗自然额度，把管理员重置后发放的额外额度留到额度用尽时
                user.nickname_change_count = (user.nickname_change_count or 0) + 1
            elif extra_quota > 0:
                # 自然额度用完但管理员在「用户管理」页重置过：用一次额外额度
                user.nickname_extra_quota = extra_quota - 1
            else:
                raise HTTPException(
                    status_code=400,
                    detail="本月昵称修改次数已达上限 (3次)，每个自然月最多允许修改3次昵称，请下月再试"
                )
            user.nickname = new_nick
            user.nickname_last_change_month = current_month

    if req.bio is not None:
        user.bio = req.bio
    if req.avatar_url is not None:
        new_avatar = req.avatar_url.strip()
        # 头像策略 v5：不再支持外部图片直链。仅允许：
        # 1) 站内上传路径 (含 /uploads/)；2) 预设符号徽章 (1~2 字符)；3) 空值 (默认徽章)
        if new_avatar and new_avatar.startswith(("http://", "https://")) and "/uploads/" not in new_avatar:
            raise HTTPException(status_code=400, detail="不支持外部图片直链头像，请使用上传本地图片或预设徽章")
        if new_avatar and not new_avatar.startswith(("http://", "https://", "/")) and len(new_avatar) > 2:
            raise HTTPException(status_code=400, detail="符号徽章最多 2 个字符；如需使用图片头像请上传本地图片")
        user.avatar_url = new_avatar or None
    if req.equipped_title is not None:
        new_title = req.equipped_title.strip() or None
        if new_title:
            # 称号越权防护：前端隐藏入口不构成校验，服务端必须验证解锁条件。
            # 条件口径与前端 AchievementsWall.getEquippableTitles 保持一致。
            posts_cnt = (await db.execute(
                select(func.count()).select_from(Post).where(Post.author_id == user.id, Post.status == "published")
            )).scalar_one()
            followers_cnt_chk = (await db.execute(
                select(func.count()).select_from(Follow).where(Follow.following_id == user.id)
            )).scalar_one()
            TITLE_CONDITIONS = {
                "全栈拓荒者": posts_cnt >= 3,
                "午夜守护者": (user.active_days or 0) >= 5,
                "代码洁癖患者": posts_cnt >= 2,
                "分布式引力源": followers_cnt_chk >= 10,
                # 深渊观测者依赖客户端本地阅读历史，服务端无对应数据，暂不限制
                "深渊观测者": True,
                "幽灵信使": (user.experience or 0) >= 50,
                "高并发捕手": (user.level or 0) >= 4,
                "赛博哲人": (user.level or 0) >= 5,
                "架构总设计师": posts_cnt >= 10 and (user.level or 0) >= 3,
                "Bug 终结者": (user.experience or 0) >= 100,
                # v5 扩充称号（与前端 AchievementsWall.getEquippableTitles 口径一致）
                "百炼成钢": (user.experience or 0) >= 500,
                "星系引力": followers_cnt_chk >= 50,
                "专栏主笔": posts_cnt >= 20,
            }
            # ① 勋章称号：允许佩戴自己已获得的任意勋章名（荣誉墙 → 称号卡）
            # 超级管理员默认拥有全部彩蛋 / 节日勋章，直接放行，不再要求 user_achievements 有记录
            if user.role == "super_admin":
                owned_medal = await db.scalar(
                    select(AchievementDef.name)
                    .where(
                        AchievementDef.active.is_(True),
                        AchievementDef.name == new_title,
                    )
                    .limit(1)
                )
            else:
                owned_medal = await db.scalar(
                    select(AchievementDef.name)
                    .join(UserAchievement, UserAchievement.code == AchievementDef.code)
                    .where(
                        UserAchievement.user_id == user.id,
                        UserAchievement.revoked_at.is_(None),
                        AchievementDef.name == new_title,
                    )
                    .limit(1)
                )
            # ② 榜单称号：当前上榜的名次称号允许佩戴（每天随榜单轮换）
            from app.routers.stats import get_user_board_titles
            # 小游戏段位称号：函数在 minigames 路由里，局部导入避免模块级循环依赖
            from app.routers.minigames import get_minigame_titles
            from sqlalchemy import text
            board_titles = await get_user_board_titles(db, user)
            # 每日结算任务发放的限时称号（未过期）同样可佩戴
            effective_title = (await db.execute(text(
                "SELECT 1 FROM user_titles WHERE user_id = :uid AND title = :t "
                "AND expires_at > now() LIMIT 1"
            ), {"uid": str(user.id), "t": new_title})).scalar_one_or_none()
            if owned_medal:
                user.equipped_title = new_title
                user.gender = user.gender if req.gender is None else user.gender
            elif new_title in board_titles or effective_title or await _is_today_festival_title(db, user, new_title) or new_title in await get_minigame_titles(db, user):
                user.equipped_title = new_title
                user.gender = user.gender if req.gender is None else user.gender
            elif new_title in TITLE_CONDITIONS:
                if not TITLE_CONDITIONS[new_title]:
                    raise HTTPException(status_code=403, detail=f"尚未解锁称号「{new_title}」，请先达成对应成就条件")
            else:
                raise HTTPException(status_code=400, detail="未知称号，无法佩戴")
        user.equipped_title = new_title
    if req.gender is not None and req.gender in ("male", "female", "secret"):
        user.gender = req.gender
    if req.tech_stack is not None:
        user.tech_stack = req.tech_stack.strip()
    if req.github_url is not None:
        user.github_url = req.github_url.strip()
    if req.blog_url is not None:
        user.blog_url = req.blog_url.strip()

    await db.commit()
    await db.refresh(user)

    # 口径与公开主页一致：排除封禁账号
    followers_cnt = (await db.execute(
        select(func.count()).select_from(Follow)
        .join(User, Follow.follower_id == User.id)
        .where(Follow.following_id == user.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )).scalar_one()
    following_cnt = (await db.execute(
        select(func.count()).select_from(Follow)
        .join(User, Follow.following_id == User.id)
        .where(Follow.follower_id == user.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )).scalar_one()
    posts_cnt = (await db.execute(select(func.count()).select_from(Post).where(Post.author_id == user.id, Post.status == "published"))).scalar_one()

    remaining_changes = _nickname_change_remaining(user)
    today = date.today()
    checkin_res = await db.execute(select(Checkin.id).where(Checkin.user_id == user.id, Checkin.checkin_date == today))
    has_checked_in = checkin_res.scalar_one_or_none() is not None

    last_checkin_days = await _current_streak(db, user.id)

    likes_cnt = (await db.execute(
        select(func.coalesce(func.sum(Post.like_count), 0)).where(Post.author_id == user.id, Post.status == "published")
    )).scalar_one_or_none() or 0

    comments_cnt = (await db.execute(
        select(func.count(Comment.id)).where(Comment.author_id == user.id, Comment.status != "deleted")
    )).scalar_one_or_none() or 0

    return UserProfileResponse(
        id=user.id,
        username=user.username,
        nickname=user.nickname,
        email=user.email,
        avatar_url=user.avatar_url,
        bio=user.bio,
        role=user.role,
        status=user.status,
        level=user.level,
        experience=user.experience,
        active_days=user.active_days,
        created_at=user.created_at,
        remaining_anon_quota=0,
        remaining_nickname_changes=remaining_changes,
        followers_count=followers_cnt,
        following_count=following_cnt,
        posts_count=posts_cnt,
        is_following=False,
        is_blocked=False,
        is_blocked_by=False,
        dnd_enabled=bool(user.dnd_enabled),
        open_post_in_new_tab=bool(getattr(user, "open_post_in_new_tab", False)),
        hide_following=bool(user.hide_following),
        hide_followers=bool(user.hide_followers),
        hide_favorites=bool(user.hide_favorites),
        hide_ip_location=bool(getattr(user, "hide_ip_location", False)),
        has_checked_in_today=has_checked_in,
        equipped_title=user.equipped_title,
        continuous_checkin_days=last_checkin_days,
        likes_received_count=int(likes_cnt),
        comments_count=int(comments_cnt),
        gender=getattr(user, "gender", "secret") or "secret",
        tech_stack=getattr(user, "tech_stack", "") or "",
        github_url=getattr(user, "github_url", "") or "",
        blog_url=getattr(user, "blog_url", "") or "",
        ip_location=getattr(user, "ip_location", "") or "",
        register_channel=getattr(user, "register_channel", "public") or "public",
        must_change_password=bool(getattr(user, "must_change_password", False)),
        email_verified=bool(getattr(user, "email_verified", False)),
        github_bound=bool(getattr(user, "github_id", None)),
        gitee_bound=bool(getattr(user, "gitee_id", None)),
    )


@router.post("/me/email/bind")
async def bind_email(
    req: BindEmailRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """更换/绑定邮箱：需先向新邮箱发送 bind_email 验证码。"""
    email = str(req.email).strip().lower()
    if email == (user.email or "").strip().lower():
        raise HTTPException(status_code=400, detail="新邮箱与当前邮箱相同")

    taken = (await db.execute(select(User.id).where(User.email == email))).scalar_one_or_none()
    if taken and taken != user.id:
        raise HTTPException(status_code=400, detail="该邮箱已被其他账号使用")

    # 30 天冷却：被盗号后无法立刻把邮箱换成攻击者的地址再走找回密码
    changed_at = getattr(user, "email_changed_at", None)
    if changed_at:
        if changed_at.tzinfo is None:
            changed_at = changed_at.replace(tzinfo=timezone.utc)
        remaining = timedelta(days=30) - (datetime.now(timezone.utc) - changed_at)
        if remaining.total_seconds() > 0:
            days = max(1, math.ceil(remaining.total_seconds() / 86400))
            raise HTTPException(
                status_code=400,
                detail=f"邮箱每 30 天仅可更换一次，还需等待约 {days} 天",
            )

    ok, msg = await verify_code("bind_email", email, req.code)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)

    # 先记录旧邮箱，供变更后发送安全提醒
    old_email = (user.email or "").strip().lower()
    user.email = email
    user.email_verified = True
    user.email_verified_at = datetime.now(timezone.utc)
    user.email_changed_at = datetime.now(timezone.utc)
    db.add(Notification(
        receiver_id=user.id,
        action_type="system",
        target_id=user.id,
        brief=f"你的账号已绑定新邮箱 {email}，如果不是本人操作请立即修改密码并联系管理员。",
    ))
    # 安全提醒发往旧邮箱：邮箱被换绑时原主人应能第一时间发现
    await db.commit()
    if old_email and old_email != email and "@users.noreply" not in old_email:
        try:
            from app.services.email_service import send_email, build_email_changed_email

            subject, html, text = build_email_changed_email(old_email, email)
            await send_email(old_email, subject, html, text)
        except Exception:
            pass
    return {"message": "邮箱已更新并完成验证", "email": email}


def _current_session_id(request: Request) -> str:
    """从 Bearer Access Token 中取出当前会话 ID（用于标记"本机"）。"""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return ""
    payload = decode_token(auth_header[7:].strip()) or {}
    # 只接受 access token：refresh 被误当 Bearer 时会标错「当前设备」
    if payload.get("type") != "access":
        return ""
    return str(payload.get("sid") or "")


@router.get("/me/sessions", response_model=List[SessionItem])
async def list_login_sessions(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """当前账号的登录设备列表（已下线的设备不展示）。"""
    rows = (await db.execute(
        select(UserSession)
        .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .order_by(UserSession.last_active_at.desc())
    )).scalars().all()

    current_sid = _current_session_id(request)

    # 按「设备 + IP」聚合：同一个浏览器反复登录/续签会产生大量会话记录，
    # 逐条列出会让用户以为有几十台陌生设备在线。这里合并成一条并给出登录次数。
    grouped: dict[tuple[str, str], list] = {}
    for item in rows:
        grouped.setdefault((item.device or "未知设备", item.ip or ""), []).append(item)

    merged: list[SessionItem] = []
    for (device, ip), group in grouped.items():
        group.sort(key=lambda x: x.last_active_at or x.created_at, reverse=True)
        latest = group[0]
        merged.append(
            SessionItem(
                id=latest.id,
                device=device,
                ip=ip,
                created_at=min(x.created_at for x in group),
                last_active_at=latest.last_active_at,
                is_current=any(current_sid and x.id == current_sid for x in group),
                session_count=len(group),
            )
        )

    merged.sort(key=lambda x: x.last_active_at or x.created_at, reverse=True)
    return merged


@router.delete("/me/sessions/{session_id}")
async def revoke_login_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """下线指定设备；当前设备也可下线（前端随后清除本地凭证）。"""
    session = await get_session(db, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(status_code=404, detail="该登录设备不存在或已下线")

    # 列表里同一「设备 + IP」被合并成一条，下线时把该组全部会话一起吊销，
    # 避免出现"点了退出，列表里还剩好几条同设备记录"
    same_device = (await db.execute(
        select(UserSession).where(
            UserSession.user_id == user.id,
            UserSession.revoked_at.is_(None),
            UserSession.device == session.device,
            UserSession.ip == session.ip,
        )
    )).scalars().all()
    for item in same_device:
        await revoke_session(db, item)
    if session.revoked_at is None:
        await revoke_session(db, session)
    await db.commit()
    return {"message": "该设备已下线"}


@router.delete("/me/sessions")
async def revoke_other_sessions(
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """一键下线除当前设备外的所有登录会话。"""
    current_sid = _current_session_id(request)
    stmt = update(UserSession).where(
        UserSession.user_id == user.id,
        UserSession.revoked_at.is_(None),
    )
    if current_sid:
        stmt = stmt.where(UserSession.id != current_sid)
    result = await db.execute(
        stmt.values(revoked_at=datetime.now(timezone.utc))
    )
    await db.commit()
    return {"message": "其他设备已全部下线", "count": result.rowcount or 0}


@router.put("/me/password")
async def change_password(
    req: PasswordChangeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if not await verify_password_async(req.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码输入错误")
    # 改密场景拿得到当前账号身份，额外拦掉「密码包含用户名/邮箱前缀」
    from app.core.password_policy import validate_password_against_identity
    try:
        validate_password_against_identity(req.new_password, user.username, user.email or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    user.password_hash = await get_password_hash_async(req.new_password)
    # 已完成首次改密，解除强制改密限制
    user.must_change_password = False
    # 自增令牌版本：改密后所有旧 access/refresh 令牌（含其他设备）立即失效
    user.token_version = (user.token_version or 0) + 1
    await db.commit()
    return {
        "message": "密码修改成功，其他设备的登录状态已失效，请使用新密码重新登录",
        "force_relogin": True
    }


@router.post("/me/deactivate")
async def deactivate_account(
    req: DeactivateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """自助注销账号：进入 10 天缓冲期（可被超级管理员恢复）。

    凭据规则：
    - 第三方登录（GitHub / Gitee）注册的用户没有密码，改为输入自己的用户名确认；
    - 密码用户验证登录密码。

    处置策略（缓冲期内可逆）：
    - 状态置为 deleting，并记录 purge_after = 现在 + DELETION_GRACE_DAYS；
    - 用户名/邮箱/头像等身份信息**保持不变**，因此用户名在整个缓冲期仍被占用；
    - 内容整体隐藏：帖子 published/scheduled → hidden，评论 visible → hidden；
    - 会话吊销：token_version 自增，所有设备立即登出；缓冲期内无法再登录；
    - 到期后由定时任务彻底清除；期间超级管理员可一键恢复全部数据。
    """
    if user.role in ("super_admin", "admin", "moderator", "auditor"):
        raise HTTPException(status_code=403, detail="管理员账号不可自助注销，请联系超级管理员处理")

    # 第三方登录（GitHub / Gitee）注册的账号没有可用密码，改为输入用户名确认；
    # 其余账号必须验证登录密码；register_channel 缺失的历史账号按密码处理。
    oauth_channel = (user.register_channel or "").lower() in ("github", "gitee")
    if oauth_channel or not user.password_hash:
        # 与 GitHub 自家高危操作一致：手输用户名确认
        confirm = (req.confirm_username or "").strip()
        if not confirm or confirm.lower() != (user.username or "").lower():
            raise HTTPException(status_code=400, detail=f"用户名确认不匹配，请输入「{user.username}」以确认注销")
    else:
        if not req.password or not await verify_password_async(req.password, user.password_hash):
            raise HTTPException(status_code=400, detail="密码验证失败，无法注销")

    purge_after = await request_user_deletion(db, user)
    return {
        "message": (
            f"账号已进入注销缓冲期，{purge_after:%Y-%m-%d %H:%M} 前可联系超级管理员恢复；"
            "到期后你发布的所有内容将被彻底清除且无法找回。"
        ),
        "deactivated": True,
        "purged": False,
        "purge_after": purge_after.isoformat(),
        "grace_days": settings.DELETION_GRACE_DAYS,
    }


@router.get("/me/invite-codes")
async def get_my_invite_codes(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """我的邀请码配额与我生成的邀请码列表 (个人主页「成长与特权」展示)"""
    from app.services.invite_service import get_invite_quota
    quota = await get_invite_quota(db, user)
    codes = (await db.execute(
        select(InviteCode).where(
            InviteCode.generator_id == user.id,
            InviteCode.expires_at > datetime.now(timezone.utc),
        )
        .order_by(InviteCode.created_at.desc()).limit(50)
    )).scalars().all()
    return {
        **quota,
        "codes": [
            {
                "code": c.code,
                "is_used": c.is_used,
                "used_by": str(c.used_by_id) if c.used_by_id else None,
                "expires_at": c.expires_at.isoformat() if c.expires_at else None,
                "created_at": c.created_at.isoformat() if c.created_at else None,
            }
            for c in codes
        ],
    }


@router.post("/me/invite-codes")
async def generate_my_invite_codes(
    count: int = 1,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """普通用户 (Lv.3+) 生成限时邀请码：

    - Lv.3 ~ Lv.5: 每 72 小时 1 个，72 小时时效
    - Lv.6: 每 72 小时 3 个，72 小时时效
    管理角色请使用管理后台入口 (30 天时效)。
    """
    from app.services.invite_service import generate_invite_codes as _gen
    if user.role in ("super_admin", "admin", "moderator"):
        raise HTTPException(status_code=400, detail="管理角色请前往管理后台生成邀请码 (30 天时效)")
    codes, expires, err = await _gen(db, user, max(1, min(count, 3)))
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {"codes": codes, "expires_at": expires}


@router.get("/me/posts", response_model=List[PostSimpleResponse])
async def get_my_posts(
    status: str = Query("published", pattern=r"^(published|draft|all)$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    from sqlalchemy.orm import selectinload
    query = select(Post).options(selectinload(Post.category), selectinload(Post.poll)).where(
        Post.author_id == user.id,
    )
    if status == "published":
        query = query.where(Post.status == "published").order_by(Post.created_at.desc())
    elif status == "draft":
        query = query.where(Post.status == "draft").order_by(Post.updated_at.desc())
    else:
        query = query.where(Post.status.in_(["published", "draft"])).order_by(Post.created_at.desc())

    res = await db.execute(query)
    posts = res.scalars().all()
    result = []
    for p in posts:
        _, r_time = extract_toc_and_reading_time(p.content_md)
        actual_title = p.title
        if not actual_title or "今日技术头条与架构前沿精选" in actual_title:
            extracted = smart_extract_title_from_md(p.content_md, p.post_type, p.created_at)
            if extracted:
                actual_title = extracted
        result.append(PostSimpleResponse(
            id=p.id,
            title=actual_title,
            post_type=p.post_type,
            status=p.status,
            is_pinned=p.is_pinned,
            view_count=p.view_count,
            like_count=p.like_count,
            comment_count=p.comment_count,
            cover_image=p.cover_image,
            created_at=p.updated_at or p.created_at,
            reading_time_minutes=r_time,
            author_id=user.id,
            author_username=user.username,
            author_nickname=user.nickname,
            author_avatar=user.avatar_url,
            author_level=user.level,
            category_id=p.category_id,
            category_name=p.category.name if p.category else None,
            tags=[t for t in p.tags.split(",") if t] if p.tags else [],
            poll_id=p.poll.id if p.poll else None
        ))
    return result

@router.get("/me/collections", response_model=List[PostSimpleResponse])
async def get_my_collections(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    from sqlalchemy.orm import selectinload
    col_query = select(Collection).where(Collection.user_id == user.id).order_by(Collection.created_at.desc())
    col_res = await db.execute(col_query)
    collections = col_res.scalars().all()
    post_ids = [c.post_id for c in collections]
    if not post_ids:
        return []

    posts_query = select(Post).options(selectinload(Post.author), selectinload(Post.category), selectinload(Post.poll)).where(
        Post.id.in_(post_ids),
        Post.status == "published"
    )
    posts_res = await db.execute(posts_query)
    posts_map = {p.id: p for p in posts_res.scalars().all()}

    result = []
    for c in collections:
        p = posts_map.get(c.post_id)
        if not p:
            continue
        _, r_time = extract_toc_and_reading_time(p.content_md)
        actual_title = p.title
        if not actual_title or "今日技术头条与架构前沿精选" in actual_title:
            extracted = smart_extract_title_from_md(p.content_md, p.post_type, p.created_at)
            if extracted:
                actual_title = extracted
        result.append(PostSimpleResponse(
            id=p.id,
            title=actual_title,
            group_name=getattr(c, "group_name", None) or "默认收藏",
            post_type=p.post_type,
            status=p.status,
            is_pinned=p.is_pinned,
            is_essence=bool(getattr(p, 'is_essence', False)),
            view_count=p.view_count,
            like_count=p.like_count,
            comment_count=p.comment_count,
            cover_image=p.cover_image,
            created_at=p.created_at,
            reading_time_minutes=r_time,
            author_id=p.author_id,
            author_username=p.author.username if p.author else "用户已注销",
            author_nickname=p.author.nickname if p.author else None,
            author_avatar=p.author.avatar_url if p.author else "",
            author_level=p.author.level if p.author else 0,
            category_id=p.category_id,
            category_name=p.category.name if p.category else None,
            tags=[t for t in p.tags.split(",") if t] if p.tags else [],
            poll_id=p.poll.id if p.poll else None
        ))
    return result

NOTIFICATION_CATEGORY_TYPES = {
    "interaction": ["comment", "reply", "like_post", "like_comment", "mention", "food_comment", "food_reply", "food_like"],
    "follow": ["follow"],
    "system": ["system", "level_up", "level_down", "essence_post", "accepted_solution", "game_invite", "ai_daily_digest"],
}


@router.get("/me/notifications")
async def get_my_notifications(
    response: Response,
    category: str = Query("all", pattern="^(all|interaction|follow|system|chat)$"),
    page: int = Query(1, ge=1),
    size: int = Query(40, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    # 分类下推到服务端：否则某一类通知在已加载的 40 条里为空时，用户永远翻不到历史
    conditions = [Notification.receiver_id == user.id]
    if category in NOTIFICATION_CATEGORY_TYPES:
        conditions.append(Notification.action_type.in_(NOTIFICATION_CATEGORY_TYPES[category]))
    elif category == "chat":
        conditions.append(
            or_(
                Notification.action_type == "chat_message",
                Notification.action_type.like("group_%"),
            )
        )

    query = (
        select(Notification, User)
        .outerjoin(User, Notification.sender_id == User.id)
        .where(*conditions)
        .order_by(Notification.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    res = await db.execute(query)
    rows = res.all()
    response.headers["X-Has-More"] = "1" if len(rows) >= size else "0"

    # 服务端聚合口径：同一来源（类型 + 目标）的全量未读数，
    # 让翻页后也能显示「累计 N 条」，而不只是当前页的连续合并
    totals = {}
    try:
        total_rows = (await db.execute(
            select(Notification.action_type, Notification.target_id, func.count())
            .where(
                Notification.receiver_id == user.id,
                Notification.is_read == False,
                Notification.target_id.isnot(None),
            )
            .group_by(Notification.action_type, Notification.target_id)
        )).all()
        totals = {(r[0], str(r[1])): int(r[2]) for r in total_rows}
    except Exception:
        totals = {}
    # 折叠明细：当前页里被折叠的组，各取最近 5 条，供前端展开查看具体是哪几条
    group_items: dict = {}
    hot_keys = {
        (n.action_type, n.target_id)
        for n, _ in rows
        if n.target_id and totals.get((n.action_type, str(n.target_id)), 0) > 1
    }
    for atype, tid in hot_keys:
        try:
            detail_rows = (await db.execute(
                select(Notification, User)
                .outerjoin(User, Notification.sender_id == User.id)
                .where(
                    Notification.receiver_id == user.id,
                    Notification.action_type == atype,
                    Notification.target_id == tid,
                    Notification.is_read == False,
                )
                .order_by(Notification.created_at.desc())
                .limit(5)
            )).all()
            group_items[(atype, tid)] = [
                {
                    "id": str(dn.id),
                    "brief": dn.brief,
                    "created_at": format_utc_iso(dn.created_at),
                    "sender_nickname": du.nickname if du else None,
                    "sender_username": du.username if du else None,
                }
                for dn, du in detail_rows
            ]
        except Exception:
            continue

    seen_group_keys: dict = {}
    result = []
    for n, u in rows:
        gkey = (n.action_type, n.target_id)
        result.append({
            "id": str(n.id),
            "action_type": n.action_type,
            "target_id": str(n.target_id) if n.target_id else None,
            "brief": n.brief,
            "is_read": n.is_read,
            "created_at": format_utc_iso(n.created_at),
            "comment_id": str(n.comment_id) if getattr(n, 'comment_id', None) else None,
            "sender_username": u.username if u else None,
            "sender_nickname": u.nickname if u else None,
            "sender_avatar": u.avatar_url if u else None,
            "group_total": totals.get((n.action_type, str(n.target_id)), 0) if n.target_id else 0,
            # 明细只挂在组里第一条（代表卡片）上，避免每行重复下发同一份数据
            "group_items": (
                group_items.get((n.action_type, n.target_id), [])
                if n.target_id and not seen_group_keys.get((n.action_type, n.target_id), False)
                else []
            ),
        })
        if n.target_id:
            seen_group_keys[gkey] = True
    return result

@router.get("/me/notifications/unread-count")
async def get_unread_notifications_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """轻量级获取当前用户未读系统/互动通知总数 (用于导航栏铃铛红点即时显示与定时巡检)"""
    query = select(func.count(Notification.id)).where(
        Notification.receiver_id == user.id,
        Notification.is_read == False
    )
    count = (await db.execute(query)).scalar() or 0
    return {"unread_count": count}

class ReadGroupPayload(BaseModel):
    action_type: str = Field(..., max_length=32)
    target_id: Optional[str] = Field(None, max_length=64)


@router.put("/me/notifications/read-group")
async def mark_notification_group_read(
    req: ReadGroupPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """把同一来源（类型 + 目标）的未读通知一次性标为已读。

    前端把同组通知折叠成一张卡片，点「已读」时不能只更新代表条，
    否则其余 N-1 条会被已读卡片吞掉，红点永远清不掉。
    """
    cond = [
        Notification.receiver_id == user.id,
        Notification.is_read == False,
        Notification.action_type == req.action_type,
    ]
    if req.target_id:
        try:
            cond.append(Notification.target_id == uuid.UUID(req.target_id))
        except ValueError:
            raise HTTPException(status_code=400, detail="目标 ID 无效")
    else:
        cond.append(Notification.target_id.is_(None))
    res = await db.execute(update(Notification).where(*cond).values(is_read=True))
    await db.commit()
    return {"ok": True, "updated": res.rowcount or 0}


@router.put("/me/notifications/read")
async def mark_notifications_read(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    from sqlalchemy import update
    stmt = update(Notification).where(Notification.receiver_id == user.id, Notification.is_read == False).values(is_read=True)
    await db.execute(stmt)
    await db.commit()
    return {"success": True}

@router.put("/me/notifications/{notification_id}/read")
async def mark_single_notification_read(
    notification_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """将单条指定消息通知标记为已读"""
    from sqlalchemy import update
    stmt = update(Notification).where(
        Notification.id == notification_id,
        Notification.receiver_id == user.id,
        Notification.is_read == False
    ).values(is_read=True)
    await db.execute(stmt)
    await db.commit()
    return {"success": True}


@router.delete("/me/notifications/{notification_id}")
async def delete_single_notification(
    notification_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """删除单条消息通知"""
    stmt = delete(Notification).where(Notification.id == notification_id, Notification.receiver_id == user.id)
    await db.execute(stmt)
    await db.commit()
    return {"success": True}

@router.delete("/me/notifications")
async def clear_all_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """一键清空个人所有消息通知"""
    stmt = delete(Notification).where(Notification.receiver_id == user.id)
    await db.execute(stmt)
    await db.commit()
    return {"success": True}

@router.get("/{username}/posts", response_model=List[PostSimpleResponse])
async def get_user_posts(
    username: str,
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    from sqlalchemy.orm import selectinload
    u_query = select(User).where(User.username == username)
    u_res = await db.execute(u_query)
    target = u_res.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="未找到该用户")

    # 隐私与黑名单拦截：如果对方把我拉黑了，直接返回空列表保护隐私
    if current_user:
        by_res = await db.execute(select(UserBlock).where(UserBlock.blocker_id == target.id, UserBlock.blocked_id == current_user.id))
        if by_res.scalar_one_or_none():
            return []

    query = select(Post).options(selectinload(Post.category), selectinload(Post.poll)).where(
        Post.author_id == target.id,
        Post.status == "published"
    ).order_by(Post.created_at.desc())
    res = await db.execute(query)
    posts = res.scalars().all()
    result = []
    for p in posts:
        _, r_time = extract_toc_and_reading_time(p.content_md)
        actual_title = p.title
        if not actual_title or "今日技术头条与架构前沿精选" in actual_title:
            extracted = smart_extract_title_from_md(p.content_md, p.post_type, p.created_at)
            if extracted:
                actual_title = extracted
        result.append(PostSimpleResponse(
            id=p.id,
            title=actual_title,
            post_type=p.post_type,
            status=p.status,
            is_pinned=p.is_pinned,
            view_count=p.view_count,
            like_count=p.like_count,
            comment_count=p.comment_count,
            cover_image=p.cover_image,
            created_at=p.created_at,
            reading_time_minutes=r_time,
            author_id=target.id,
            author_username=target.username,
            author_nickname=target.nickname,
            author_avatar=target.avatar_url,
            author_level=target.level,
            category_id=p.category_id,
            category_name=p.category.name if p.category else None,
            tags=[t for t in p.tags.split(",") if t] if p.tags else [],
            poll_id=p.poll.id if p.poll else None
        ))
    return result

@router.post("/{username}/follow")
async def follow_user(
    username: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if current_user.username == username:
        raise HTTPException(status_code=400, detail="不可关注自己")

    u_query = select(User).where(User.username == username)
    target = (await db.execute(u_query)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    # 检查黑名单关系
    block_check = await db.execute(
        select(UserBlock).where(
            or_(
                and_(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target.id),
                and_(UserBlock.blocker_id == target.id, UserBlock.blocked_id == current_user.id)
            )
        )
    )
    if block_check.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="由于黑名单限制，无法关注该用户")

    f_query = select(Follow).where(Follow.follower_id == current_user.id, Follow.following_id == target.id)
    if not (await db.execute(f_query)).scalar_one_or_none():
        new_follow = Follow(follower_id=current_user.id, following_id=target.id)
        db.add(new_follow)
        try:
            await db.flush()
        except IntegrityError:
            # 并发重复关注：唯一约束兜底，直接视为已关注
            await db.rollback()
            return
        # 发送系统关注通知
        notif = Notification(
            receiver_id=target.id,
            sender_id=current_user.id,
            action_type="follow",
            brief=f"{current_user.nickname or current_user.username} 关注了你"
        )
        db.add(notif)
        await db.commit()

    return {"message": f"已成功关注 @{target.username}", "is_following": True}

@router.delete("/{username}/follow")
async def unfollow_user(
    username: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    u_query = select(User).where(User.username == username)
    target = (await db.execute(u_query)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    stmt = delete(Follow).where(Follow.follower_id == current_user.id, Follow.following_id == target.id)
    await db.execute(stmt)
    await db.commit()
    return {"message": f"已取消关注 @{target.username}", "is_following": False}

@router.get("/{username}/following", response_model=FollowListResponse)
async def get_user_following(
    username: str,
    q: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    target = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    is_self = current_user and current_user.id == target.id
    is_admin = current_user and current_user.role in ["super_admin", "admin"]
    if target.hide_following and not is_self and not is_admin:
        return FollowListResponse(hidden=True, total=0, items=[])

    stmt = (
        select(User)
        .join(Follow, Follow.following_id == User.id)
        .where(Follow.follower_id == target.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )
    if q and q.strip():
        cq = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.username.ilike(cq), User.nickname.ilike(cq)))

    cnt_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(cnt_stmt)).scalar_one()

    stmt = stmt.order_by(Follow.created_at.desc()).offset((page - 1) * size).limit(size)
    users = (await db.execute(stmt)).scalars().all()

    following_set = set()
    if current_user and users:
        target_ids = [u.id for u in users]
        f_res = await db.execute(select(Follow.following_id).where(Follow.follower_id == current_user.id, Follow.following_id.in_(target_ids)))
        following_set = set(f_res.scalars().all())

    online_ids = await _online_user_ids([u.id for u in users])

    items = []
    for u in users:
        f_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.following_id == u.id))).scalar_one()
        fol_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.follower_id == u.id))).scalar_one()
        items.append(FollowUserItem(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            avatar_url=u.avatar_url,
            bio=u.bio or "",
            level=u.level,
            role=u.role,
            followers_count=f_cnt,
            following_count=fol_cnt,
            is_following=(u.id in following_set),
            # 对方开启「隐藏在线状态」时对他人恒为离线，和主页保持同一口径
            is_online=(u.id in online_ids and not getattr(u, "hide_online_status", False)),
        ))

    return FollowListResponse(hidden=False, total=total, items=items)

@router.get("/{username}/followers", response_model=FollowListResponse)
async def get_user_followers(
    username: str,
    q: Optional[str] = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    target = (await db.execute(select(User).where(User.username == username))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    is_self = current_user and current_user.id == target.id
    is_admin = current_user and current_user.role in ["super_admin", "admin"]
    if target.hide_followers and not is_self and not is_admin:
        return FollowListResponse(hidden=True, total=0, items=[])

    stmt = (
        select(User)
        .join(Follow, Follow.follower_id == User.id)
        .where(Follow.following_id == target.id, User.status.not_in(("banned", "deactivated", "deleting")))
    )
    if q and q.strip():
        cq = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.username.ilike(cq), User.nickname.ilike(cq)))

    cnt_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(cnt_stmt)).scalar_one()

    stmt = stmt.order_by(Follow.created_at.desc()).offset((page - 1) * size).limit(size)
    users = (await db.execute(stmt)).scalars().all()

    following_set = set()
    if current_user and users:
        target_ids = [u.id for u in users]
        f_res = await db.execute(select(Follow.following_id).where(Follow.follower_id == current_user.id, Follow.following_id.in_(target_ids)))
        following_set = set(f_res.scalars().all())

    online_ids = await _online_user_ids([u.id for u in users])

    items = []
    for u in users:
        f_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.following_id == u.id))).scalar_one()
        fol_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.follower_id == u.id))).scalar_one()
        items.append(FollowUserItem(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            avatar_url=u.avatar_url,
            bio=u.bio or "",
            level=u.level,
            role=u.role,
            followers_count=f_cnt,
            following_count=fol_cnt,
            is_following=(u.id in following_set),
            # 对方开启「隐藏在线状态」时对他人恒为离线，和主页保持同一口径
            is_online=(u.id in online_ids and not getattr(u, "hide_online_status", False)),
        ))

    return FollowListResponse(hidden=False, total=total, items=items)

@router.post("/{username}/block")
async def block_user(
    username: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if current_user.username == username:
        raise HTTPException(status_code=400, detail="不可拉黑自己")

    u_query = select(User).where(User.username == username)
    target = (await db.execute(u_query)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    if target.role in ["super_admin", "admin"] and current_user.role not in ["super_admin", "admin"]:
        raise HTTPException(status_code=403, detail="不可拉黑社区管理员")

    b_check = await db.execute(select(UserBlock).where(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target.id))
    if not b_check.scalar_one_or_none():
        new_block = UserBlock(blocker_id=current_user.id, blocked_id=target.id)
        db.add(new_block)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            return

        # 自动双向解除关注
        del_follow = delete(Follow).where(
            or_(
                and_(Follow.follower_id == current_user.id, Follow.following_id == target.id),
                and_(Follow.follower_id == target.id, Follow.following_id == current_user.id)
            )
        )
        await db.execute(del_follow)
        await db.commit()

    return {"message": f"已将 @{target.username} 加入黑名单", "is_blocked": True}

@router.delete("/{username}/block")
async def unblock_user(
    username: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    u_query = select(User).where(User.username == username)
    target = (await db.execute(u_query)).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    stmt = delete(UserBlock).where(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target.id)
    await db.execute(stmt)
    await db.commit()
    return {"message": f"已将 @{target.username} 移出黑名单", "is_blocked": False}

@router.get("/me/blocks", response_model=List[BlockedUserItem])
async def get_my_blocks(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    query = (
        select(UserBlock, User)
        .join(User, UserBlock.blocked_id == User.id)
        .where(UserBlock.blocker_id == current_user.id)
        .order_by(UserBlock.created_at.desc())
    )
    res = await db.execute(query)
    rows = res.all()
    result = []
    for ub, u in rows:
        result.append(BlockedUserItem(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            avatar_url=u.avatar_url,
            blocked_at=ub.created_at
        ))
    return result

@router.put("/me/dnd")
async def toggle_dnd(
    req: DndUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    current_user.dnd_enabled = req.dnd_enabled
    await db.commit()
    return {"message": "免打扰设置已更新", "dnd_enabled": current_user.dnd_enabled}




# ==================== 头像按需缩放 ====================

@router.get("/avatar")
async def get_avatar_variant(
    path: str = Query(..., max_length=300, description="头像相对路径，必须以 /uploads/ 开头"),
    w: int = Query(64, ge=32, le=1024, description="目标边长，按 32 对齐"),
):
    """把已上传的头像按需缩放成小图。

    头像在页面上经常只占 20~72px，直接下发 512 原图很浪费流量。
    这里首次访问时生成一档派生图并落盘，之后由 nginx 缓存 30 天，
    无需回填历史头像，也不需要改上传逻辑。
    """
    import hashlib
    import os

    from fastapi.responses import FileResponse
    from PIL import Image

    rel = (path or "").strip()
    if not rel.startswith("/uploads/") or ".." in rel:
        raise HTTPException(status_code=400, detail="非法的头像路径")

    src = os.path.join(settings.UPLOAD_DIR, rel[len("/uploads/"):])
    if not os.path.isfile(src):
        raise HTTPException(status_code=404, detail="头像不存在")

    # 对齐到 32 的倍数，避免为每个像素尺寸都生成一份
    size = min(512, max(32, (int(w) // 32) * 32))
    digest = hashlib.md5(rel.encode("utf-8")).hexdigest()
    derived_dir = os.path.join(settings.UPLOAD_DIR, "derived")
    out_path = os.path.join(derived_dir, f"avatar_{digest}_{size}.webp")

    if not os.path.isfile(out_path):
        try:
            os.makedirs(derived_dir, exist_ok=True)
            with Image.open(src) as img:
                img = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img
                img.thumbnail((size, size), Image.Resampling.LANCZOS)
                img.save(out_path, format="WEBP", quality=82, method=4)
        except Exception:
            raise HTTPException(status_code=500, detail="头像处理失败")

    return FileResponse(
        out_path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )


class MutedChatsPayload(BaseModel):
    groups: List[str] = Field(default_factory=list, max_length=100)
    convs: List[str] = Field(default_factory=list, max_length=100)


@router.get("/me/muted")
async def get_muted_chats(user: User = Depends(get_current_user)):
    """读取云端免打扰设置（多端同步）。"""
    raw = getattr(user, "muted_chats", None) or {}
    return {
        "groups": raw.get("groups", []) if isinstance(raw, dict) else [],
        "convs": raw.get("convs", []) if isinstance(raw, dict) else [],
    }


@router.put("/me/muted")
async def update_muted_chats(
    payload: MutedChatsPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """保存免打扰设置到云端，其他设备登录后自动同步。"""
    user.muted_chats = {"groups": payload.groups, "convs": payload.convs}
    await db.commit()
    return {"ok": True}


class CollectionGroupPayload(BaseModel):
    group_name: str = Field(default="默认收藏", max_length=32)


@router.put("/me/collections/{post_id}/group")
async def set_collection_group(
    post_id: UUID,
    payload: CollectionGroupPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """设置某篇收藏的分组（收藏夹分组功能）。"""
    from app.models.post import Collection
    col = (await db.execute(
        select(Collection).where(Collection.user_id == user.id, Collection.post_id == post_id)
    )).scalar_one_or_none()
    if not col:
        raise HTTPException(status_code=404, detail="该文章不在收藏夹中")
    col.group_name = (payload.group_name or "默认收藏").strip()[:32] or "默认收藏"
    await db.commit()
    return {"ok": True, "group_name": col.group_name}




def _clean_folder_name(raw: str) -> str:
    """收藏夹名：去掉控制字符与尖括号，其余保留（中文/空格/emoji 都允许）。"""
    import re as _re
    name = _re.sub(r"[<>\x00-\x1f\x7f]", "", (raw or "")).strip()
    return name[:32]


class CollectionFolderPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)


@router.get("/me/collection-folders")
async def list_collection_folders(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """列出我的收藏夹（含每夹文章数）。默认收藏永远存在。"""
    from app.models.post import Collection, CollectionFolder
    named = (await db.execute(
        select(CollectionFolder.name).where(CollectionFolder.user_id == user.id)
    )).scalars().all()
    used = (await db.execute(
        select(Collection.group_name).where(Collection.user_id == user.id).distinct()
    )).scalars().all()
    counts = dict((await db.execute(
        select(Collection.group_name, func.count())
        .where(Collection.user_id == user.id)
        .group_by(Collection.group_name)
    )).all())
    names = ["默认收藏"] + sorted({n for n in list(named) + list(used) if n and n != "默认收藏"})
    return [{"name": n, "count": int(counts.get(n, 0))} for n in names]


@router.post("/me/collection-folders")
async def create_collection_folder(
    payload: CollectionFolderPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """新建收藏夹（可为空夹）。"""
    from app.models.post import CollectionFolder
    name = _clean_folder_name(payload.name)
    if not name:
        raise HTTPException(status_code=400, detail="收藏夹名称不能为空")
    folder = CollectionFolder(user_id=user.id, name=name)
    db.add(folder)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        return {"name": name, "count": 0, "existed": True}
    return {"name": name, "count": 0}


@router.delete("/me/collection-folders/{name}")
async def delete_collection_folder(
    name: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """删除收藏夹，夹内文章移回「默认收藏」而不是取消收藏。"""
    from app.models.post import CollectionFolder, Collection
    if name == "默认收藏":
        raise HTTPException(status_code=400, detail="默认收藏夹不可删除")
    await db.execute(
        update(Collection).where(
            Collection.user_id == user.id, Collection.group_name == name
        ).values(group_name="默认收藏")
    )
    await db.execute(
        delete(CollectionFolder).where(
            CollectionFolder.user_id == user.id, CollectionFolder.name == name
        )
    )
    await db.commit()
    return {"ok": True}


@router.put("/me/collection-folders/{name}")
async def rename_collection_folder(
    name: str,
    payload: CollectionFolderPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """重命名收藏夹（夹内文章同步换组）。"""
    from app.models.post import CollectionFolder, Collection
    if name == "默认收藏":
        raise HTTPException(status_code=400, detail="默认收藏夹不可重命名")
    new_name = _clean_folder_name(payload.name)
    if not new_name:
        raise HTTPException(status_code=400, detail="收藏夹名称不能为空")
    if new_name == name:
        return {"ok": True, "name": new_name}
    folder = (await db.execute(
        select(CollectionFolder).where(
            CollectionFolder.user_id == user.id, CollectionFolder.name == name
        )
    )).scalar_one_or_none()
    if not folder:
        raise HTTPException(status_code=404, detail="收藏夹不存在")
    folder.name = new_name
    await db.execute(
        update(Collection).where(
            Collection.user_id == user.id, Collection.group_name == name
        ).values(group_name=new_name)
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="已存在同名收藏夹")
    return {"ok": True, "name": new_name}


class FolderMergePayload(BaseModel):
    source: str = Field(..., min_length=1, max_length=32)
    target: str = Field(default="默认收藏", max_length=32)


@router.post("/me/collection-folders/merge")
async def merge_collection_folders(
    payload: FolderMergePayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """合并收藏夹：把 source 下的文章全部移到 target，并删除 source。"""
    from app.models.post import CollectionFolder, Collection
    source = payload.source.strip()[:32]
    target = (payload.target or "默认收藏").strip()[:32] or "默认收藏"
    if source == target:
        raise HTTPException(status_code=400, detail="不能合并到自身")
    if source == "默认收藏":
        raise HTTPException(status_code=400, detail="默认收藏夹不可作为被合并方")
    moved = (await db.execute(
        update(Collection)
        .where(Collection.user_id == user.id, Collection.group_name == source)
        .values(group_name=target)
    )).rowcount or 0
    await db.execute(
        delete(CollectionFolder).where(
            CollectionFolder.user_id == user.id, CollectionFolder.name == source
        )
    )
    await db.commit()
    return {"ok": True, "moved": int(moved), "target": target}


async def _is_today_festival_title(db: AsyncSession, user: User, title: str) -> bool:
    """当天解锁的节日勋章可以佩戴，过期自动失效。"""
    try:
        from datetime import date as _date
        from zoneinfo import ZoneInfo
        from app.models.achievement import UserAchievement
        from app.services.festival import today_festival

        fest = today_festival()
        if not fest or fest["name"] != title:
            return False
        ua = (await db.execute(
            select(UserAchievement).where(
                UserAchievement.user_id == user.id, UserAchievement.code == fest["code"]
            )
        )).scalar_one_or_none()
        if not ua or not ua.unlocked_at:
            return False
        return ua.unlocked_at.astimezone(ZoneInfo("Asia/Shanghai")).date() == _date.today()
    except Exception:
        return False


@router.get("/me/reports")
async def get_my_reports(
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """举报人查看自己提交过的举报及处理进度（含结论与理由）"""
    from app.models.system import Report as _Report
    labels = {
        "spam": "垃圾广告 / 推广营销", "attack": "人身攻击 / 恶意辱骂",
        "illegal": "违法违规内容", "privacy": "侵权 / 隐私泄露", "other": "其他违规事由",
    }
    status_labels = {"pending": "待处理", "resolved": "已处理", "rejected": "已驳回"}
    rows = (await db.execute(
        select(_Report)
        .where(_Report.reporter_id == user.id)
        .order_by(_Report.created_at.desc())
        .offset((page - 1) * size).limit(size)
    )).scalars().all()
    return [{
        "id": r.id,
        "target_type": r.target_type,
        "target_id": str(r.target_id),
        "reason_label": labels.get(r.reason_type, r.reason_type),
        "description": r.description or "",
        "image_url": getattr(r, "image_url", None),
        "status": r.status,
        "status_label": status_labels.get(r.status, r.status),
        "resolve_note": r.resolve_note or "",
        "created_at": r.created_at,
        "handled_at": getattr(r, "handled_at", None),
    } for r in rows]
