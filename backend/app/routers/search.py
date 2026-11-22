"""搜索建议接口：输入过程中的文章 / 用户联想"""

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.post import Post
from app.models.user import User

def _escape_like(value: str) -> str:
    """转义 LIKE 通配符：用户搜 % / _ 时不该命中全表。"""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


router = APIRouter(prefix="/search", tags=["搜索"])


@router.get("/suggest")
async def suggest(
    q: str = Query(..., min_length=1, max_length=40),
    limit: int = Query(default=5, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    query = q.strip()
    if not query:
        return {"posts": [], "users": []}
    escaped = _escape_like(query)
    keyword = f"%{escaped}%"
    prefix = f"{escaped}%"

    posts = (await db.execute(
        select(Post.id, Post.title)
        .where(Post.status == "published", Post.title.ilike(keyword, escape="\\"))
        .order_by(Post.created_at.desc())
        .limit(limit)
    )).all()

    users = (await db.execute(
        select(User.username, User.nickname, User.avatar_url)
        .where(
            User.status == "active",
            User.username.ilike(keyword, escape="\\") | User.nickname.ilike(keyword, escape="\\"),
        )
        .order_by(case(
            (func.lower(User.username) == query.lower(), 0),
            (User.username.ilike(prefix, escape="\\"), 1),
            (func.lower(User.nickname) == query.lower(), 2),
            (User.nickname.ilike(prefix, escape="\\"), 3),
            else_=4,
        ), func.lower(User.username), User.id)
        .limit(limit)
    )).all()

    return {
        "posts": [{"id": str(p.id), "title": p.title} for p in posts],
        "users": [
            {"username": u.username, "nickname": u.nickname or u.username, "avatar": u.avatar_url or ""}
            for u in users
        ],
    }
