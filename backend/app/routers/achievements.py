"""勋章与成就接口

公开：
    GET /achievements/catalog        可见勋章定义
    GET /achievements/user/{id}      某用户已获得的勋章
    GET /achievements/me             我获得的勋章

仅超级管理员：
    GET  /admin/achievements/defs    全部定义（含隐藏）
    POST /admin/achievements/defs    新建自定义勋章
    POST /admin/achievements/grant   授予（支持批量）
    POST /admin/achievements/revoke  撤销（软删除）
    GET  /admin/achievements/grants  最近颁发记录
"""

import uuid
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.achievement import AchievementDef, UserAchievement
from app.models.system import Notification
from app.models.user import User
from app.services.achievement_engine import EGG_CODES, evaluate_user, snapshot_series, unlock_egg
from app.routers.deps import get_current_user, get_current_user_optional, get_current_root_admin

router = APIRouter(prefix="/achievements", tags=["勋章与成就"])
admin_router = APIRouter(prefix="/admin/achievements", tags=["勋章管理"])


def _def_dict(d: AchievementDef) -> Dict[str, Any]:
    return {
        "code": d.code,
        "name": d.name,
        "subtitle": d.subtitle or "",
        "description": d.description or "",
        "icon": d.icon or "🏅",
        "category": d.category,
        "series": d.series,
        "tier": int(d.tier or 0),
        "target": int(d.target or 0),
        "hidden": bool(d.hidden),
        "category": d.category,
        "custom": bool(d.custom),
    }


async def _grant_one(
    db: AsyncSession,
    target: User,
    definition: AchievementDef,
    admin: User,
    reason: str,
) -> bool:
    """授予单个勋章；已存在则升级/恢复，返回是否有变化"""
    existing = (
        await db.execute(
            select(UserAchievement).where(
                UserAchievement.user_id == target.id,
                UserAchievement.code == definition.code,
            )
        )
    ).scalar_one_or_none()

    if existing is None:
        db.add(
            UserAchievement(
                user_id=target.id,
                code=definition.code,
                tier=definition.tier,
                reason=reason[:200],
                granted_by=admin.id,
            )
        )
        changed = True
    elif existing.revoked_at is not None:
        # 撤销过的重新颁发：恢复并记新的授予人与理由
        existing.revoked_at = None
        existing.granted_by = admin.id
        existing.reason = reason[:200]
        existing.unlocked_at = utc_now()
        changed = True
    elif definition.tier > (existing.tier or 0):
        existing.tier = definition.tier
        changed = True
    else:
        changed = False

    if changed:
        db.add(
            Notification(
                receiver_id=target.id,
                sender_id=admin.id,
                action_type="system",
                brief=f"你获得了勋章「{definition.name}」{(' · ' + reason) if reason else ''}",
            )
        )
    return changed


@router.get("/catalog")
async def list_catalog(db: AsyncSession = Depends(get_db)) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(
            select(AchievementDef)
            .where(AchievementDef.active.is_(True))
            .order_by(AchievementDef.category, AchievementDef.series, AchievementDef.tier)
        )
    ).scalars().all()
    return [_def_dict(d) for d in rows if not d.hidden]


@router.get("/user/{user_id}")
async def list_user_achievements(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(
            select(UserAchievement, AchievementDef)
            .join(AchievementDef, AchievementDef.code == UserAchievement.code)
            .where(
                UserAchievement.user_id == user_id,
                UserAchievement.revoked_at.is_(None),
            )
            .order_by(desc(AchievementDef.tier), desc(UserAchievement.unlocked_at))
        )
    ).all()
    out = []
    for ua, definition in rows:
        item = _def_dict(definition)
        item.update(
            {
                "tier": int(ua.tier or 0),
                "reason": ua.reason or "",
                "unlocked_at": ua.unlocked_at.isoformat() if ua.unlocked_at else None,
            }
        )
        out.append(item)

    # 超级管理员默认拥有全部隐藏成就（展示层合成，不写库）
    target_user = (await db.execute(
        select(User).where(User.id == user_id)
    )).scalar_one_or_none()
    if target_user and target_user.role == "super_admin":
        owned_codes = {i["code"] for i in out}
        hidden_defs = (await db.execute(
            select(AchievementDef).where(AchievementDef.hidden.is_(True))
        )).scalars().all()
        for d in hidden_defs:
            if d.code in owned_codes:
                continue
            item = _def_dict(d)
            item.update({
                "tier": int(d.tier or 0),
                "reason": "超级管理员默认拥有全部隐藏成就",
                "unlocked_at": datetime.now(timezone.utc).isoformat(),
            })
            out.append(item)

    return out


@router.get("/me")
async def list_my_achievements(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    return await list_user_achievements(user.id, db)


# ---------------- 超级管理员 ----------------


@admin_router.get("/defs")
async def admin_list_defs(
    _: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(
            select(AchievementDef).order_by(desc(AchievementDef.custom), AchievementDef.series, AchievementDef.tier)
        )
    ).scalars().all()
    return [_def_dict(d) for d in rows]


class CustomDefPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)
    subtitle: str = Field(default="", max_length=48)
    description: str = Field(default="", max_length=200)
    icon: str = Field(default="🏅", max_length=16)
    tier: int = Field(default=2, ge=0, le=3)
    hidden: bool = False


@admin_router.post("/defs")
async def admin_create_def(
    payload: CustomDefPayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> Dict[str, Any]:
    code = f"custom_{uuid.uuid4().hex[:10]}"
    definition = AchievementDef(
        code=code,
        name=payload.name,
        subtitle=payload.subtitle,
        description=payload.description,
        icon=payload.icon or "🏅",
        category="custom",
        series=None,
        tier=payload.tier,
        target=0,
        hidden=payload.hidden,
        custom=True,
        created_by=admin.id,
        sort=100,
    )
    db.add(definition)
    await db.commit()

    try:
        from app.routers.admin import write_admin_audit
        write_admin_audit(db, admin, "create_achievement", None, f"{code}:{payload.name}", request)
        await db.commit()
    except Exception:
        pass
    return _def_dict(definition)


@admin_router.delete("/defs/{code}")
async def admin_delete_def(
    code: str,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> Dict[str, Any]:
    """删除自定义勋章（内置勋章不可删，避免误删后种子数据与线上不一致）"""
    definition = (
        await db.execute(select(AchievementDef).where(AchievementDef.code == code))
    ).scalar_one_or_none()
    if not definition:
        raise HTTPException(status_code=404, detail="勋章不存在")
    if not definition.custom:
        raise HTTPException(status_code=400, detail="内置勋章不可删除，只能删除自定义勋章")

    # 连带清理该勋章的授予记录，避免留下悬空的 user_achievements 行
    await db.execute(delete(UserAchievement).where(UserAchievement.code == code))
    deleted_name = definition.name
    await db.delete(definition)
    await db.commit()

    try:
        from app.routers.admin import write_admin_audit
        write_admin_audit(db, admin, "delete_achievement", None, f"{code}:{deleted_name}", request)
        await db.commit()
    except Exception:
        pass

    return {"message": "已删除", "code": code, "name": deleted_name}


class GrantPayload(BaseModel):
    user_id: uuid.UUID
    codes: List[str] = Field(..., min_length=1, max_length=20)
    reason: str = Field(default="", max_length=200)


@admin_router.post("/grant")
async def admin_grant(
    payload: GrantPayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> Dict[str, Any]:
    target = (await db.execute(select(User).where(User.id == payload.user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    defs = (
        await db.execute(select(AchievementDef).where(AchievementDef.code.in_(payload.codes)))
    ).scalars().all()
    if not defs:
        raise HTTPException(status_code=400, detail="勋章不存在")

    granted = []
    for definition in defs:
        if await _grant_one(db, target, definition, admin, payload.reason):
            granted.append(definition.name)

    await db.commit()

    try:
        from app.routers.admin import write_admin_audit
        write_admin_audit(
            db, admin, "grant_achievement", target.id,
            f"@{target.username} <- {','.join(granted) or '无变化'}", request,
        )
        await db.commit()
    except Exception:
        pass

    return {"message": "颁发完成", "granted": granted, "user": target.username}


class RevokePayload(BaseModel):
    user_id: uuid.UUID
    code: str


@admin_router.post("/revoke")
async def admin_revoke(
    payload: RevokePayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    record = (
        await db.execute(
            select(UserAchievement).where(
                UserAchievement.user_id == payload.user_id,
                UserAchievement.code == payload.code,
                UserAchievement.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="该用户没有这枚勋章")
    record.revoked_at = utc_now()
    await db.commit()
    return {"message": "已撤销"}


@admin_router.get("/grants")
async def admin_list_grants(
    limit: int = Query(default=30, ge=1, le=200),
    _: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    rows = (
        await db.execute(
            select(UserAchievement, AchievementDef, User)
            .join(AchievementDef, AchievementDef.code == UserAchievement.code)
            .join(User, User.id == UserAchievement.user_id)
            .where(UserAchievement.revoked_at.is_(None))
            .order_by(desc(UserAchievement.unlocked_at))
            .limit(limit)
        )
    ).all()
    return [
        {
            "user_id": str(ua.user_id),
            "username": user.username,
            "nickname": user.nickname or user.username,
            "code": ua.code,
            "name": definition.name,
            "icon": definition.icon,
            "tier": int(ua.tier or 0),
            "reason": ua.reason or "",
            "unlocked_at": ua.unlocked_at.isoformat() if ua.unlocked_at else None,
        }
        for ua, definition, user in rows
    ]


@router.get("/wall/{user_id}")
async def achievement_wall(
    user_id: uuid.UUID,
    viewer: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """荣誉墙数据：系列进度（含自动判定）+ 特别成就 + 隐藏成就 + 稀有度"""
    target = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="用户不存在")

    series: List[Dict[str, Any]] = []
    # 只有本人访问时才跑实时判定，避免看别人主页时反复写库
    if viewer and viewer.id == target.id:
        result = await evaluate_user(db, target)
        series = result["series"]

    defs = (await db.execute(
        select(AchievementDef).where(AchievementDef.active.is_(True))
    )).scalars().all()
    owned_rows = (await db.execute(
        select(UserAchievement).where(
            UserAchievement.user_id == user_id, UserAchievement.revoked_at.is_(None)
        )
    )).scalars().all()
    owned_codes = {ua.code for ua in owned_rows}

    if not series:
        # 他人主页：只读统计真实进度，不授予、不写库
        series = await snapshot_series(db, target)

    specials = [
        {**_def_dict(d), "owned": d.code in owned_codes}
        for d in defs if d.category == "special"
    ]
    # 彩蛋：未解锁时不下发名称与「发现方式」，避免抓包提前剧透；
    # 只有本人真正解锁后才返回 description，用来告诉他是怎么发现的
    # 只有本人能看到「自己解锁了哪些彩蛋」以及每个彩蛋的发现方式。
    # 别人来访时连"解锁了几个"都不该暴露，因此统一按未解锁形态下发（??? + 空描述）。
    is_owner = bool(viewer and viewer.id == target.id)

    # 彩蛋互见：只有「双方都解锁了同一个彩蛋」时，才能看到对方解锁了什么。
    # 一方解锁、另一方没解锁时，对他而言仍然是 ???，不会泄露"这个人偷偷解锁了彩蛋"。
    viewer_codes: set[str] = set()
    if viewer and not is_owner:
        try:
            viewer_codes = set(
                (await db.execute(
                    select(UserAchievement.code).where(
                UserAchievement.user_id == viewer.id,
                UserAchievement.revoked_at.is_(None),
            )
                )).scalars().all()
            )
        except Exception:
            viewer_codes = set()

    # 开源版：不内置隐藏彩蛋，接口保留，固定返回空列表
    eggs = []
    egg_total = 0

    # 勋章本身可公开展示（这是荣誉墙的意义），但「简介」与「颁发理由」只对本人可见
    medals = []
    for ua in owned_rows:
        d = next((x for x in defs if x.code == ua.code), None)
        if d is None:
            continue
        item = {
            **_def_dict(d),
            "tier": int(ua.tier or 0),
            "unlocked_at": ua.unlocked_at.isoformat() if ua.unlocked_at else None,
            "reason": (ua.reason or "") if is_owner else "",
        }
        if not is_owner:
            item["description"] = ""
            item["subtitle"] = ""
        medals.append(item)

    # 稀有度：该勋章持有人数 / 总用户数
    total_users = int(await db.scalar(select(func.count(User.id)).where(User.status != "deleted")) or 1)
    rarity_rows = (await db.execute(
        select(UserAchievement.code, func.count(UserAchievement.id))
        .where(UserAchievement.revoked_at.is_(None))
        .group_by(UserAchievement.code)
    )).all()
    rarity = {
        code: round(count / total_users * 100, 1)
        for code, count in rarity_rows
    }

    return {
        "medals": medals,
        "series": series,
        "specials": specials,
        "eggs": eggs,
        "stats": {
            "owned": len(medals),
                               "egg_total": egg_total,
            "rarity": rarity,
            "total_users": total_users,
        },
    }


class UnlockPayload(BaseModel):
    code: str

@router.post("/unlock")
async def unlock_hidden(
    payload: UnlockPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    return await unlock_egg(db, user, payload.code)

class TitlePayload(BaseModel):
    user_id: uuid.UUID
    title: str = Field(default="", max_length=48)


@admin_router.post("/title")
async def admin_set_title(
    payload: TitlePayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
    request: Request = None,
) -> Dict[str, Any]:
    """超级管理员为他人设置/清除佩戴称号"""
    target = (await db.execute(select(User).where(User.id == payload.user_id))).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    target.equipped_title = payload.title.strip() or None
    db.add(Notification(
        receiver_id=target.id,
        sender_id=admin.id,
        action_type="system",
        brief=f"管理员为你设置了称号「{target.equipped_title}」" if target.equipped_title else "管理员清除了你的称号",
    ))
    await db.commit()

    try:
        from app.routers.admin import write_admin_audit
        write_admin_audit(db, admin, "set_title", target.id, f"@{target.username} -> {payload.title or '(清空)'}", request)
        await db.commit()
    except Exception:
        pass

    return {"message": "称号已更新", "title": target.equipped_title or ""}


@router.get("/festival")
async def festival_today(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """今天的节日彩蛋：当天首次进入自动解锁，并告知前端是否播放庆祝动画。"""
    from datetime import date
    from zoneinfo import ZoneInfo
    from app.services.festival import today_festival

    fest = today_festival()
    if not fest:
        return {"active": False}

    today_local = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    existing = (await db.execute(
        select(UserAchievement).where(
            UserAchievement.user_id == user.id, UserAchievement.code == fest["code"]
        )
    )).scalar_one_or_none()

    first_visit = False
    if not existing:
        db.add(UserAchievement(user_id=user.id, code=fest["code"], tier=0, progress=1))
        db.add(Notification(
            receiver_id=user.id,
            action_type="system",
            brief=f"今天是{fest['name']}，你获得了限时节日勋章 {fest['icon']}，仅限今天佩戴",
        ))
        await db.commit()
        first_visit = True
    elif not existing.unlocked_at or existing.unlocked_at.astimezone(ZoneInfo("Asia/Shanghai")).date() != today_local:
        existing.unlocked_at = utc_now()
        existing.revoked_at = None
        await db.commit()
        first_visit = True

    return {
        "active": True,
        "first_visit": first_visit,
        "code": fest["code"],
        "name": fest["name"],
        "icon": fest["icon"],
        "wish": fest["wish"],
        "title": fest["name"],
    }


class CrazyThursdayPayload(BaseModel):
    text: str = Field("", max_length=500)


@router.post("/crazy-thursday")
async def crazy_thursday(
    payload: CrazyThursdayPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """开源版：接口保留，不提供任何彩蛋判定与内容。"""
    return {"triggered": False}
