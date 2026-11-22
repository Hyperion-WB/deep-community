from typing import Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.comment import Comment
from app.models.post import Post
from app.models.reaction import Reaction
from app.models.user import User
from app.routers.deps import get_current_user, get_current_user_optional, is_admin_role

router = APIRouter(prefix="/reactions", tags=["表情反应"])

# 与前端 REACTION_LIST 保持一致，防止任意字符串写库
ALLOWED_EMOJIS = {"👍", "❤️", "🚀", "💡", "🎉", "🔥"}


class ReactionToggleRequest(BaseModel):
    target_type: str = Field(..., pattern="^(post|comment)$")
    target_id: UUID
    emoji: str = Field(..., min_length=1, max_length=8)


async def _assert_target_visible(db: AsyncSession, target_type: str, target_id: UUID, user: Optional[User]):
    """仅允许对可见内容做反应：草稿/已删除内容对外等同于不存在"""
    if target_type == "post":
        post = (await db.execute(select(Post).where(Post.id == target_id))).scalar_one_or_none()
        if not post or post.status == "deleted":
            raise HTTPException(status_code=404, detail="文章不存在")
        if post.status != "published":
            is_author = bool(user and user.id == post.author_id)
            is_admin = bool(user and is_admin_role(user.role))
            if not (is_author or is_admin):
                raise HTTPException(status_code=404, detail="文章不存在")
    else:
        comment = (await db.execute(select(Comment).where(Comment.id == target_id))).scalar_one_or_none()
        # hidden 是注销缓冲期的评论，对普通用户同样不可见
        if not comment or comment.status in ("deleted", "hidden"):
            raise HTTPException(status_code=404, detail="评论不存在")
        post = (await db.execute(select(Post).where(Post.id == comment.post_id))).scalar_one_or_none()
        if not post or post.status != "published":
            is_author = bool(user and user.id == post.author_id) if post else False
            is_admin = bool(user and is_admin_role(user.role))
            if not (is_author or is_admin):
                raise HTTPException(status_code=404, detail="评论不存在")


def _summarize(rows, mine) -> Dict[str, Dict[str, int]]:
    counts: Dict[str, Dict[str, int]] = {}
    for target_id, emoji, cnt in rows:
        counts.setdefault(str(target_id), {})[emoji] = int(cnt)
    for target_id in counts:
        counts[target_id].setdefault("_mine", [])
    for target_id, emoji in mine:
        key = str(target_id)
        counts.setdefault(key, {"_mine": []})
        counts[key]["_mine"].append(emoji)
    return counts


async def _summary_for(db: AsyncSession, target_type: str, target_id: UUID, user: Optional[User]):
    rows = (await db.execute(
        select(Reaction.target_id, Reaction.emoji, func.count(Reaction.id))
        .where(Reaction.target_type == target_type, Reaction.target_id == target_id)
        .group_by(Reaction.target_id, Reaction.emoji)
    )).all()
    mine = []
    if user:
        mine = (await db.execute(
            select(Reaction.target_id, Reaction.emoji).where(
                Reaction.target_type == target_type,
                Reaction.target_id == target_id,
                Reaction.user_id == user.id,
            )
        )).all()

    counts: Dict[str, int] = {}
    for _, emoji, cnt in rows:
        counts[emoji] = int(cnt)
    return {"counts": counts, "user_reactions": [e for _, e in mine]}


@router.get("/summary")
async def get_reaction_summary(
    target_type: str = Query(..., pattern="^(post|comment)$"),
    target_id: UUID = Query(...),
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    await _assert_target_visible(db, target_type, target_id, user)
    return await _summary_for(db, target_type, target_id, user)


@router.get("/batch")
async def get_reaction_batch(
    target_type: str = Query(..., pattern="^(post|comment)$"),
    target_ids: str = Query("", description="逗号分隔的目标 ID 列表"),
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    """批量拉取（用于评论区一次性取回所有表情统计，避免 N 次请求）"""
    ids: List[UUID] = []
    for raw in (target_ids or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            ids.append(UUID(raw))
        except ValueError:
            continue
    # 单次最多 200 个，避免超长查询
    ids = ids[:200]
    if not ids:
        return {"items": {}}

    rows = (await db.execute(
        select(Reaction.target_id, Reaction.emoji, func.count(Reaction.id))
        .where(Reaction.target_type == target_type, Reaction.target_id.in_(ids))
        .group_by(Reaction.target_id, Reaction.emoji)
    )).all()

    mine = []
    if user:
        mine = (await db.execute(
            select(Reaction.target_id, Reaction.emoji).where(
                Reaction.target_type == target_type,
                Reaction.target_id.in_(ids),
                Reaction.user_id == user.id,
            )
        )).all()

    items: Dict[str, Dict] = {}
    for tid, emoji, cnt in rows:
        items.setdefault(str(tid), {"counts": {}, "user_reactions": []})["counts"][emoji] = int(cnt)
    for tid, emoji in mine:
        items.setdefault(str(tid), {"counts": {}, "user_reactions": []})["user_reactions"].append(emoji)
    for tid in {str(i) for i in ids}:
        items.setdefault(tid, {"counts": {}, "user_reactions": []})

    return {"items": items}


@router.post("/toggle")
async def toggle_reaction(
    req: ReactionToggleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if req.emoji not in ALLOWED_EMOJIS:
        raise HTTPException(status_code=400, detail="不支持的表情反应")
    await _assert_target_visible(db, req.target_type, req.target_id, user)

    existing = (await db.execute(
        select(Reaction).where(
            Reaction.user_id == user.id,
            Reaction.target_type == req.target_type,
            Reaction.target_id == req.target_id,
            Reaction.emoji == req.emoji,
        )
    )).scalar_one_or_none()

    if existing:
        await db.delete(existing)
    else:
        db.add(Reaction(
            user_id=user.id,
            target_type=req.target_type,
            target_id=req.target_id,
            emoji=req.emoji,
        ))

    try:
        await db.commit()
    except IntegrityError:
        # 并发双击：唯一约束兜底，回滚后按当前真实状态返回
        await db.rollback()

    summary = await _summary_for(db, req.target_type, req.target_id, user)
    summary["toggled"] = not bool(existing)
    return summary
