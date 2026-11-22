from typing import Optional, List, Union
from uuid import UUID
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from app.core.database import get_db
from app.models.poll import Poll, PollOption, PollVote
from app.models.post import Post
from app.models.user import User
from app.schemas.interaction import PollCreateRequest, PollDetailResponse, PollOptionResponse
from app.routers.deps import get_current_user, get_current_user_optional, is_admin_role

router = APIRouter(prefix="/polls", tags=["投票系统"])

class PollVoteRequest(BaseModel):
    option_ids: List[int]


async def _assert_poll_post_visible(db: AsyncSession, poll: Poll, user: Optional[User]) -> None:
    """投票可见性跟随所属文章：草稿/定时/已删除内容不对外暴露读投能力"""
    post = (await db.execute(select(Post).where(Post.id == poll.post_id))).scalar_one_or_none()
    if not post or post.status == "deleted":
        raise HTTPException(status_code=404, detail="投票所在的文章不可用")
    if post.status != "published":
        privileged = bool(user and (post.author_id == user.id or is_admin_role(user.role)))
        if not privileged:
            raise HTTPException(status_code=404, detail="投票所在的文章不可用")

@router.post("", response_model=PollDetailResponse)
async def create_poll(
    req: PollCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    post_q = select(Post).where(Post.id == req.post_id)
    post = (await db.execute(post_q)).scalar_one_or_none()
    if not post or (post.author_id != user.id and not is_admin_role(user.role)):
        raise HTTPException(status_code=400, detail="只能为自己发布的帖子创建投票")

    exist_q = select(Poll).where(Poll.post_id == req.post_id)
    if (await db.execute(exist_q)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="该帖子已存在投票")

    expires_at = datetime.now(timezone.utc) + timedelta(days=req.expires_in_days)

    poll = Poll(
        post_id=req.post_id,
        title=req.title,
        is_multiple=req.is_multiple,
        max_choices=req.max_choices if req.is_multiple else 1,
        expires_at=expires_at
    )
    db.add(poll)
    await db.flush()

    options = []
    for opt in req.options:
        o = PollOption(poll_id=poll.id, option_text=opt.option_text)
        db.add(o)
        options.append(o)

    await db.commit()

    return PollDetailResponse(
        id=poll.id,
        title=poll.title,
        is_multiple=poll.is_multiple,
        max_choices=poll.max_choices,
        expires_at=poll.expires_at,
        is_expired=False,
        total_votes=0,
        has_voted=False,
        options=[PollOptionResponse(id=o.id, option_text=o.option_text, vote_count=0) for o in options]
    )

@router.get("/post/{post_id}", response_model=PollDetailResponse)
async def get_post_poll(
    post_id: UUID,
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    query = select(Poll).options(selectinload(Poll.options)).where(Poll.post_id == post_id)
    poll = (await db.execute(query)).scalar_one_or_none()
    if not poll:
        raise HTTPException(status_code=404, detail="该帖子无附加投票")

    await _assert_poll_post_visible(db, poll, user)

    now = datetime.now(timezone.utc)
    exp = poll.expires_at if (poll.expires_at and poll.expires_at.tzinfo) else poll.expires_at.replace(tzinfo=timezone.utc)
    is_expired = exp < now

    user_voted_options = set()
    has_voted = False
    if user:
        v_q = select(PollVote.option_id).where(PollVote.poll_id == poll.id, PollVote.user_id == user.id)
        v_res = await db.execute(v_q)
        user_voted_options = set(v_res.scalars().all())
        has_voted = len(user_voted_options) > 0

    total_votes = sum(o.vote_count for o in poll.options)
    options_res = []
    for o in poll.options:
        pct = round((o.vote_count / total_votes * 100), 1) if total_votes > 0 else 0.0
        options_res.append(PollOptionResponse(
            id=o.id,
            option_text=o.option_text,
            vote_count=o.vote_count,
            percentage=pct,
            is_voted=(o.id in user_voted_options)
        ))

    return PollDetailResponse(
        id=poll.id,
        title=poll.title,
        is_multiple=poll.is_multiple,
        max_choices=poll.max_choices,
        expires_at=poll.expires_at,
        is_expired=is_expired,
        total_votes=total_votes,
        has_voted=has_voted,
        options=options_res
    )

@router.post("/{poll_id}/vote")
async def vote_poll(
    poll_id: UUID,
    payload: Union[PollVoteRequest, List[int], int] = Body(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if user.status == "probation":
        raise HTTPException(
            status_code=403,
            detail="当前为见习会员，累计活跃 5 天后自动转正解锁参与投票特权"
        )

    if isinstance(payload, PollVoteRequest):
        option_ids = payload.option_ids
    elif isinstance(payload, int):
        option_ids = [payload]
    else:
        option_ids = payload

    if not option_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个选项进行投票")

    # 去重：客户端重复提交同一选项会撞唯一约束并导致 500，也会让票数被重复累加
    option_ids = list(dict.fromkeys(option_ids))

    query = select(Poll).options(selectinload(Poll.options)).where(Poll.id == poll_id)
    poll = (await db.execute(query)).scalar_one_or_none()
    if not poll:
        raise HTTPException(status_code=404, detail="投票不存在")

    await _assert_poll_post_visible(db, poll, user)

    exp = poll.expires_at if (poll.expires_at and poll.expires_at.tzinfo) else poll.expires_at.replace(tzinfo=timezone.utc)
    if exp < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="该投票已截止")

    # 行锁：把「检查是否投过 → 写投票记录」串行化。
    # 现有唯一约束是 (poll_id, option_id, user_id)，多选投票允许同一人投多个选项，
    # 因此不能简单加 (poll_id, user_id) 唯一约束；锁 Poll 行才能让并发请求
    # 依次执行重复检查，避免一人两票。
    await db.execute(select(Poll.id).where(Poll.id == poll.id).with_for_update())

    # 检查是否已投过
    exist_q = select(PollVote).where(PollVote.poll_id == poll.id, PollVote.user_id == user.id)
    if (await db.execute(exist_q)).scalar_one_or_none():
        raise HTTPException(status_code=400, detail="你已经参与过该投票，不可重复提交")

    if not poll.is_multiple and len(option_ids) > 1:
        raise HTTPException(status_code=400, detail="单选投票仅允许选择一个选项")
    if poll.is_multiple and len(option_ids) > poll.max_choices:
        raise HTTPException(status_code=400, detail=f"最多仅允许选择 {poll.max_choices} 个选项")

    valid_opts = {o.id: o for o in poll.options}
    for opt_id in option_ids:
        if opt_id not in valid_opts:
            raise HTTPException(status_code=400, detail=f"无效的选项 ID: {opt_id}")

        # 原子自增：此前的 ORM 读改写在同一选项被并发投票时会丢票
        await db.execute(
            update(PollOption)
            .where(PollOption.id == opt_id)
            .values(vote_count=PollOption.vote_count + 1)
        )
        vote_record = PollVote(poll_id=poll.id, option_id=opt_id, user_id=user.id)
        db.add(vote_record)

    try:
        await db.commit()
    except IntegrityError:
        # 并发双击/多端同时提交时由唯一约束兜底，回滚后按"已投过"返回，避免 500
        await db.rollback()
        raise HTTPException(status_code=400, detail="你已经参与过该投票，不可重复提交")
    return {"message": "投票成功"}
