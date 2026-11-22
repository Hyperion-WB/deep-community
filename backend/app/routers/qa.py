"""问答广场：名额、悬赏状态、采纳结算、经验兑换、流水查询。"""
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.qa import ExpLedger
from app.models.user import User
from app.routers.deps import get_current_user, get_current_user_optional
from app.services.qa_service import (
    QA_MAX_ACCEPTED, exchange_extra_quota, qa_daily_quota, qa_setting_int,
    qa_state, settle_question,
)

router = APIRouter(prefix="/qa", tags=["问答广场"])


class SettleRequest(BaseModel):
    comment_ids: List[UUID] = Field(..., min_length=1, max_length=QA_MAX_ACCEPTED)
    confirm: bool = False


@router.get("/config")
async def qa_config(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """今日提问名额、悬赏额度、采纳期与兑换价格。"""
    return {
        "quota": await qa_daily_quota(db, user),
        "bounty": await qa_setting_int(db, "qa_bounty_amount", 10),
        "accept_window_days": 7,
        "max_accepted": QA_MAX_ACCEPTED,
    }


@router.post("/exchange")
async def qa_exchange(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """用全站经验兑换今日额外 1 次提问名额。"""
    return await exchange_extra_quota(db, user)


@router.get("/posts/{post_id}")
async def qa_question_state(post_id: UUID,
                            user: Optional[User] = Depends(get_current_user_optional),
                            db: AsyncSession = Depends(get_db)):
    state = await qa_state(db, post_id, user)
    if not state:
        return {"is_qa": False}
    return {"is_qa": True, **state}


@router.post("/posts/{post_id}/settle")
async def qa_settle(post_id: UUID, req: SettleRequest,
                    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """提问者勾选 1~5 个回答、二次确认后结算悬赏。"""
    return await settle_question(db, post_id, user, [str(c) for c in req.comment_ids], req.confirm)


@router.get("/posts/{post_id}/ledger")
async def qa_ledger(post_id: UUID, user: User = Depends(get_current_user),
                    db: AsyncSession = Depends(get_db)):
    """该问题的经验流水（采纳奖励、锁定、退回、零头、扣回）。"""
    rows = (await db.execute(
        select(ExpLedger).where(ExpLedger.post_id == post_id)
        .order_by(ExpLedger.created_at.asc())
    )).scalars().all()
    return {"items": [{
        "id": str(r.id), "amount": r.amount, "direction": r.direction,
        "reason": r.reason, "user_id": str(r.user_id) if r.user_id else None,
        "comment_id": str(r.comment_id) if r.comment_id else None,
        "created_at": r.created_at,
    } for r in rows]}
