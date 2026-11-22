import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base
from app.core.timezone import utc_now


class QaQuestion(Base):
    """问答广场问题的悬赏状态机（与帖子一对一）。

    status: pending（待解决，悬赏已锁定）→ solved（已解决）/ expired（超时退回）
            / refunded（问题删除退回）/ cancelled（异常作废）
    """
    __tablename__ = "qa_questions"

    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True)
    asker_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    bounty = Column(Integer, nullable=False, default=10)
    status = Column(String(16), nullable=False, default="pending", index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    settled_at = Column(DateTime(timezone=True), nullable=True)
    accepted_count = Column(Integer, nullable=False, default=0)
    remainder = Column(Integer, nullable=False, default=0)  # 除不尽的零头，归系统积分池
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)


class ExpLedger(Base):
    """经验流水：问答悬赏的锁定 / 发放 / 退回 / 扣回 / 零头全部留痕。

    user_id 为 NULL 表示「系统经验池」一侧的账目；
    reason='问答采纳奖励' 的记录一定带 post_id + comment_id。
    """
    __tablename__ = "exp_ledger"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    amount = Column(Integer, nullable=False)
    direction = Column(String(16), nullable=False, index=True)  # lock/grant/refund/clawback/remainder
    reason = Column(String(64), nullable=False, index=True)
    post_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    comment_id = Column(UUID(as_uuid=True), nullable=True, index=True)
    idempotency_key = Column(String(160), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)


class QaExtraQuota(Base):
    """经验兑换的额外提问次数（东八区自然日）。"""
    __tablename__ = "qa_extra_quota"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    day = Column(String(10), nullable=False, index=True)
    source = Column(String(16), nullable=False, default="exchange")  # exchange / admin_grant
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)


class QaAnswer(Base):
    """问答回答登记表：唯一约束保证单用户单问题只能回答一次。"""
    __tablename__ = "qa_answers"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    comment_id = Column(UUID(as_uuid=True), ForeignKey("comments.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("post_id", "author_id", name="uq_qa_one_answer"),
    )
