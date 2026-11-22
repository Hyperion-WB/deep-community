"""自定义表情包：上传 / 收藏 / 删除。

配额：上传与收藏共用 **60 张**（用户确认的口径），删掉才能腾位置。
"""

import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.sticker import UserSticker
from app.models.user import User
from app.routers.deps import get_current_user
from app.services.sticker_service import StickerError, load_local_upload, process_sticker

router = APIRouter(prefix="/stickers", tags=["stickers"])

STICKER_LIMIT = 60


class StickerOut(BaseModel):
    id: uuid.UUID
    url: str
    thumb_url: str
    width: int
    height: int
    size: int
    is_animated: bool
    source: str

    class Config:
        from_attributes = True


class StickerListResponse(BaseModel):
    items: List[StickerOut]
    used: int
    limit: int


class CollectPayload(BaseModel):
    url: str


async def _count(db: AsyncSession, owner_id: uuid.UUID) -> int:
    return int(
        await db.scalar(
            select(func.count(UserSticker.id)).where(UserSticker.owner_id == owner_id)
        )
        or 0
    )


@router.get("/mine", response_model=StickerListResponse)
async def my_stickers(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.execute(
            select(UserSticker)
            .where(UserSticker.owner_id == user.id)
            .order_by(UserSticker.created_at.desc())
        )
    ).scalars().all()
    return StickerListResponse(items=rows, used=len(rows), limit=STICKER_LIMIT)


@router.post("/upload", response_model=StickerOut)
async def upload_sticker(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if await _count(db, user.id) >= STICKER_LIMIT:
        raise HTTPException(status_code=400, detail=f"最多只能保存 {STICKER_LIMIT} 个表情，先删掉一些吧")

    data = await file.read()
    try:
        url, thumb, width, height, size, animated = process_sticker(data)
    except StickerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # 表情包与帖子图片一样走「本地优先 + 对象存储异步镜像」：
    # 这里只登记待镜像 key，不等待上传结果，用户拿到响应的时间不受影响
    from app.services.storage_sync import enqueue_mirror

    await enqueue_mirror(url.lstrip("/"))
    if thumb:
        await enqueue_mirror(thumb.lstrip("/"))

    sticker = UserSticker(
        owner_id=user.id,
        url=url,
        thumb_url=thumb,
        width=width,
        height=height,
        size=size,
        is_animated=animated,
        source="upload",
    )
    db.add(sticker)
    await db.commit()
    await db.refresh(sticker)
    return sticker


@router.post("/collect", response_model=StickerOut)
async def collect_sticker(
    payload: CollectPayload,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """收藏别人的表情：复制文件到自己名下，不依赖来源是否被删。"""
    if await _count(db, user.id) >= STICKER_LIMIT:
        raise HTTPException(status_code=400, detail=f"最多只能保存 {STICKER_LIMIT} 个表情，先删掉一些吧")

    already = (
        await db.execute(
            select(UserSticker).where(
                UserSticker.owner_id == user.id, UserSticker.origin_url == payload.url
            )
        )
    ).scalar_one_or_none()
    if already:
        raise HTTPException(status_code=400, detail="你已经收藏过这个表情了")

    data = load_local_upload(payload.url)
    if not data:
        raise HTTPException(status_code=400, detail="表情文件不存在或不可收藏")

    try:
        url, thumb, width, height, size, animated = process_sticker(data)
    except StickerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    sticker = UserSticker(
        owner_id=user.id,
        url=url,
        thumb_url=thumb,
        width=width,
        height=height,
        size=size,
        is_animated=animated,
        source="collect",
        origin_url=payload.url,
    )
    db.add(sticker)
    await db.commit()
    await db.refresh(sticker)
    return sticker


@router.delete("/{sticker_id}")
async def delete_sticker(
    sticker_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    sticker = (
        await db.execute(
            select(UserSticker).where(
                UserSticker.id == sticker_id, UserSticker.owner_id == user.id
            )
        )
    ).scalar_one_or_none()
    if not sticker:
        raise HTTPException(status_code=404, detail="表情不存在")

    # 物理文件保留：历史评论里可能还引用着，删记录即可，避免评论出现裂图
    await db.delete(sticker)
    await db.commit()
    return {"message": "已删除"}
