import uuid
from sqlalchemy import Column, String, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from app.core.database import Base
from app.core.timezone import utc_now


class Reaction(Base):
    """文章 / 评论的表情反应（👍 ❤️ 🚀 💡 🎉 🔥）

    同一用户对同一目标的同一种表情只能存在一条记录，
    通过唯一约束保证并发点赞不会重复计数。
    """
    __tablename__ = "reactions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    target_type = Column(String(16), nullable=False)  # post / comment
    target_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    emoji = Column(String(8), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

    __table_args__ = (
        UniqueConstraint("user_id", "target_type", "target_id", "emoji", name="uq_reaction_user_target"),
    )
