import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Boolean, Text, DateTime, ForeignKey, UniqueConstraint, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.core.timezone import utc_now

class Feedback(Base):
    __tablename__ = "feedbacks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 类型: bug (问题缺陷), feature (功能建议)
    feedback_type = Column(String(32), nullable=False, default="feature", index=True)
    
    title = Column(String(200), nullable=False)
    content = Column(Text, nullable=False)
    
    # 状态:
    # 对于 bug: open (待处理), investigating (排查中), fixed (已修复), wontfix (无法复现)
    # 对于 feature: pending (待评估), under_consideration (考虑中), accepted (已采纳), completed (已完成), declined (暂不考虑)
    status = Column(String(32), nullable=False, default="pending", index=True)
    
    upvotes_count = Column(Integer, nullable=False, default=0, index=True)
    
    # 兼容旧数据的首张截图
    image_url = Column(String(512), nullable=True)
    # 多条反馈截图（最多 5 张），首张会同步写入 image_url 保持向后兼容
    image_urls = Column(JSON, nullable=True)

    # 反馈者对管理员答复的确认：
    #   ''        未确认
    #   'fixed'   Bug 已修复
    #   'unfixed' Bug 仍可复现（会把状态打回 open）
    #   'received' 建议已收到
    user_confirm = Column(String(16), nullable=False, default="")
    user_confirm_at = Column(DateTime(timezone=True), nullable=True)
    # 确认时附带的补充说明
    user_note = Column(Text, nullable=True)

    # 管理员答复与判定理由 (公开展示)
    admin_reply = Column(Text, nullable=True)
    admin_replied_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    admin_replied_at = Column(DateTime(timezone=True), nullable=True)
    
    # v2：数据驱动子分区 / 草稿 / 撤回
    category = Column(String(32), nullable=False, default="other", server_default="other")
    is_draft = Column(Boolean, nullable=False, default=False, server_default="false")
    withdrawn_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    user = relationship("User", foreign_keys=[user_id])
    admin = relationship("User", foreign_keys=[admin_replied_by])
    upvotes = relationship("FeedbackUpvote", back_populates="feedback", cascade="all, delete-orphan")

class FeedbackUpvote(Base):
    __tablename__ = "feedback_upvotes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    feedback_id = Column(UUID(as_uuid=True), ForeignKey("feedbacks.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    feedback = relationship("Feedback", back_populates="upvotes")

    __table_args__ = (
        UniqueConstraint("feedback_id", "user_id", name="uq_user_feedback_upvote"),
    )


class FeedbackCategory(Base):
    """反馈子分区：数据驱动，新增分区只需插一行，不用改前端枚举。"""
    __tablename__ = "feedback_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_type = Column(String(16), nullable=False)
    name = Column(String(32), nullable=False)
    sort = Column(Integer, nullable=False, default=0, server_default="0")
    active = Column(Boolean, nullable=False, default=True, server_default="true")

    __table_args__ = (
        UniqueConstraint("parent_type", "name", name="uq_feedback_category"),
    )
