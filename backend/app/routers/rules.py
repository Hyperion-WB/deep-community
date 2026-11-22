# -*- coding: utf-8 -*-
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, desc
from sqlalchemy.exc import IntegrityError

from app.core.database import get_db
from app.core.timezone import utc_now
from app.core.default_rules import DEFAULT_RULES_TITLE, DEFAULT_RULES_CONTENT
from app.models.user import User
from app.models.system import CommunityRule, CommunityEndorsement
from app.routers.deps import get_current_user_optional, get_current_user, get_current_super_admin
from app.core.cache import get_cached_json, set_cached_json, invalidate_rules_cache

router = APIRouter(prefix="/rules", tags=["rules"])


class RuleUpdateRequest(BaseModel):
    title: str = Field(..., min_length=2, max_length=200, description="公约标题")
    content: str = Field(..., min_length=10, description="公约完整Markdown内容")


class EndorsementRequest(BaseModel):
    stance: Optional[str] = Field("pledge", max_length=64, description="表态态度：pledge(承诺恪守), support(认同支持)")
    comment: Optional[str] = Field("恪守极客自治公约，共同守护纯粹交流空间", max_length=255, description="表态宣言")


@router.get("")
async def get_community_rules(
    current_user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    """获取社区公约、用户表态统计及最近签署列表 (公开接口，全员及访客均可访问)"""
    stmt = select(CommunityRule).order_by(CommunityRule.id.desc()).limit(1)
    res = await db.execute(stmt)
    rule = res.scalar_one_or_none()

    if not rule:
        rule = CommunityRule(
            title=DEFAULT_RULES_TITLE,
            content=DEFAULT_RULES_CONTENT,
            version=1,
            updated_at=utc_now()
        )
        db.add(rule)
        await db.commit()
        await db.refresh(rule)

    if not current_user:
        cached = await get_cached_json("cache:rules:public")
        if cached is not None:
            return cached

    # 统计签署总数
    count_stmt = select(func.count(CommunityEndorsement.id))
    total_endorsements = (await db.execute(count_stmt)).scalar() or 0

    # 当前用户签署状态
    user_endorsed = False
    user_endorsement = None
    if current_user:
        u_stmt = select(CommunityEndorsement).where(CommunityEndorsement.user_id == current_user.id)
        u_end = (await db.execute(u_stmt)).scalar_one_or_none()
        if u_end:
            user_endorsed = True
            user_endorsement = {
                "id": u_end.id,
                "stance": u_end.stance,
                "comment": u_end.comment,
                "created_at": u_end.created_at.isoformat() if u_end.created_at else None
            }

    # 最近签署成员列表 (按时间倒序展示最近 15 位极客)
    recent_stmt = (
        select(CommunityEndorsement, User)
        .join(User, CommunityEndorsement.user_id == User.id)
        .order_by(CommunityEndorsement.id.desc())
        .limit(15)
    )
    recent_res = (await db.execute(recent_stmt)).all()
    recent_list = []
    for end_item, u_item in recent_res:
        recent_list.append({
            "id": end_item.id,
            "user_id": str(u_item.id),
            "username": u_item.username,
            "nickname": u_item.nickname,
            "avatar_url": u_item.avatar_url,
            "level": u_item.level,
            "stance": end_item.stance,
            "comment": end_item.comment,
            "created_at": end_item.created_at.isoformat() if end_item.created_at else None
        })

    result = {
        "id": rule.id,
        "title": rule.title,
        "content": rule.content,
        "version": rule.version,
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else None,
        "endorsements_count": total_endorsements,
        "user_endorsed": user_endorsed,
        "user_endorsement": user_endorsement,
        "recent_endorsements": recent_list
    }
    if not current_user:
        await set_cached_json("cache:rules:public", result, ttl=300)
    return result


@router.put("")
async def update_community_rules(
    payload: RuleUpdateRequest,
    current_admin: User = Depends(get_current_super_admin),
    db: AsyncSession = Depends(get_db)
):
    """最高管理员/管理员更新社区自治公约与入站必读内容"""
    stmt = select(CommunityRule).order_by(CommunityRule.id.desc()).limit(1)
    res = await db.execute(stmt)
    rule = res.scalar_one_or_none()

    new_title = payload.title.strip()
    new_content = payload.content.strip()

    if not new_title or not new_content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="公约标题与正文不能为空")

    if rule:
        rule.title = new_title
        rule.content = new_content
        rule.version = (rule.version or 1) + 1
        rule.updated_by = current_admin.id
        rule.updated_at = utc_now()
    else:
        rule = CommunityRule(
            title=new_title,
            content=new_content,
            version=1,
            updated_by=current_admin.id,
            updated_at=utc_now()
        )
        db.add(rule)

    await db.commit()
    await db.refresh(rule)
    await invalidate_rules_cache()

    return {
        "success": True,
        "message": "公约与入站必读规范已更新发布",
        "id": rule.id,
        "title": rule.title,
        "version": rule.version,
        "updated_at": rule.updated_at.isoformat() if rule.updated_at else None
    }


@router.post("/endorse")
async def endorse_community_rules(
    payload: EndorsementRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """用户对社区公约签署承诺与表态认同"""
    u_stmt = select(CommunityEndorsement).where(CommunityEndorsement.user_id == current_user.id)
    u_end = (await db.execute(u_stmt)).scalar_one_or_none()

    stance = (payload.stance or "pledge").strip()[:64]
    comment = (payload.comment or "恪守极客自治公约，共同守护纯粹交流空间").strip()[:255]

    if u_end:
        u_end.stance = stance
        u_end.comment = comment
        u_end.created_at = utc_now()
    else:
        u_end = CommunityEndorsement(
            user_id=current_user.id,
            stance=stance,
            comment=comment,
            created_at=utc_now()
        )
        db.add(u_end)

    try:
        await db.commit()
    except IntegrityError:
        # 并发首签：user_id 唯一约束兜底，回滚后改为更新既有记录
        await db.rollback()
        u_end = (await db.execute(u_stmt)).scalar_one_or_none()
        if u_end:
            u_end.stance = stance
            u_end.comment = comment
            u_end.created_at = utc_now()
            await db.commit()
        else:
            raise HTTPException(status_code=500, detail="签署失败，请稍后重试")
    await invalidate_rules_cache()

    count_stmt = select(func.count(CommunityEndorsement.id))
    total_endorsements = (await db.execute(count_stmt)).scalar() or 0

    return {
        "success": True,
        "message": "已成功签署并表态承诺恪守社区公约",
        "user_endorsed": True,
        "endorsements_count": total_endorsements,
        "endorsement": {
            "stance": u_end.stance,
            "comment": u_end.comment,
            "created_at": u_end.created_at.isoformat() if u_end.created_at else None
        }
    }


@router.delete("/endorse")
async def revoke_endorsement(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """用户撤销对公约的签署与表态"""
    u_stmt = select(CommunityEndorsement).where(CommunityEndorsement.user_id == current_user.id)
    u_end = (await db.execute(u_stmt)).scalar_one_or_none()

    if u_end:
        await db.delete(u_end)
        await db.commit()
    await invalidate_rules_cache()

    count_stmt = select(func.count(CommunityEndorsement.id))
    total_endorsements = (await db.execute(count_stmt)).scalar() or 0

    return {
        "success": True,
        "message": "已撤回公约签署",
        "user_endorsed": False,
        "endorsements_count": total_endorsements
    }
