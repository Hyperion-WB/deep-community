import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, Boolean, Text, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.core.database import Base

class Comment(Base):
    __tablename__ = "comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("comments.id", ondelete="CASCADE"), nullable=True, index=True)
    reply_to_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    content = Column(Text, nullable=False)

    # 单条评论最多一张图：普通图片与自定义表情共用该字段，用 image_kind 区分展示方式
    image_url = Column(String(512), nullable=False, default="")
    image_kind = Column(String(16), nullable=False, default="")  # '' / photo / sticker
    
    # 匿名机制
    is_anonymous = Column(Boolean, nullable=False, default=False, index=True)
    anonymous_alias = Column(String(64), nullable=True) # 例如 "神秘雪豹#12"
    
    # 互动与管理
    is_featured = Column(Boolean, nullable=False, default=False) # 楼主置顶/精选
    is_accepted = Column(Boolean, nullable=False, default=False, index=True) # 采纳的最佳解答
    like_count = Column(Integer, nullable=False, default=0)
    # visible / deleted / blocked
    status = Column(String(16), nullable=False, default="visible", index=True)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    # 关联
    post = relationship("Post", back_populates="comments")
    author = relationship("User", back_populates="comments", foreign_keys=[author_id])
    replies = relationship("Comment", back_populates="parent", cascade="all, delete-orphan")
    parent = relationship("Comment", remote_side=[id], back_populates="replies")
