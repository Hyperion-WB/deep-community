import uuid

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base


class UserSticker(Base):
    """自定义表情包：上传与收藏共用同一个 30 张配额。

    动图（gif / 动态 webp）原样存储，不走 webp 转码——
    统一转码会把动画压成首帧。列表里用 thumb_url（首帧静图）渲染，hover 再播动图。
    """

    __tablename__ = "user_stickers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    url = Column(String(512), nullable=False)
    thumb_url = Column(String(512), nullable=False, default="")
    width = Column(Integer, nullable=False, default=0)
    height = Column(Integer, nullable=False, default=0)
    size = Column(Integer, nullable=False, default=0)
    is_animated = Column(Boolean, nullable=False, default=False)

    # upload：自己上传；collect：收藏别人的（文件已复制，不依赖来源）
    source = Column(String(16), nullable=False, default="upload")
    origin_url = Column(String(512), nullable=False, default="")

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
