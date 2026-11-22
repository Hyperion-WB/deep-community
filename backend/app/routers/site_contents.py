"""静态页面内容（免责与法律声明等）：公开读、超管写。"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.system import SiteContent
from app.models.user import User
from app.routers.deps import get_current_root_admin, get_current_user_optional

router = APIRouter(prefix="/site-contents", tags=["site-contents"])

DEFAULTS = {"legal": "免责与法律声明"}


class SiteContentUpdate(BaseModel):
    title: Optional[str] = Field(None, max_length=200)
    content: str = Field("", max_length=200000)


@router.get("/{key}")
async def get_site_content(
    key: str,
    db: AsyncSession = Depends(get_db),
    user: Optional[User] = Depends(get_current_user_optional),
):
    row = (await db.execute(select(SiteContent).where(SiteContent.key == key))).scalar_one_or_none()
    if not row:
        if key not in DEFAULTS:
            raise HTTPException(status_code=404, detail="内容不存在")
        return {"key": key, "title": DEFAULTS[key], "content": "", "updated_at": None}
    return {"key": row.key, "title": row.title, "content": row.content, "updated_at": row.updated_at}


@router.put("/{key}")
async def update_site_content(
    key: str, payload: SiteContentUpdate,
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(SiteContent).where(SiteContent.key == key))).scalar_one_or_none()
    if not row:
        row = SiteContent(key=key, title=payload.title or DEFAULTS.get(key, key), content=payload.content)
        db.add(row)
    else:
        if payload.title is not None:
            row.title = payload.title
        row.content = payload.content
        row.updated_by = admin.id
    await db.commit()
    return {"ok": True, "key": key}
