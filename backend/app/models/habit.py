from __future__ import annotations

from uuid import uuid4

from sqlalchemy import Boolean, CheckConstraint, Column, Date, DateTime, ForeignKey, Index, Integer, LargeBinary, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base
from app.core.timezone import utc_now


class HabitGoal(Base):
    __tablename__ = "habit_goals"
    __table_args__ = (
        CheckConstraint("visibility IN ('public', 'private')", name="ck_habit_goal_visibility"),
        Index("ix_habit_goal_owner_created", "owner_id", "created_at"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(60), nullable=False)
    description = Column(String(300), nullable=False, default="")
    visibility = Column(String(7), nullable=False, default="private")
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
    last_date = Column(Date)
    streak = Column(Integer, nullable=False, default=0)
    longest_streak = Column(Integer, nullable=False, default=0)
    public_last_date = Column(Date)
    public_streak = Column(Integer, nullable=False, default=0)
    public_longest_streak = Column(Integer, nullable=False, default=0)


class HabitCheckin(Base):
    __tablename__ = "habit_checkins"
    __table_args__ = (
        UniqueConstraint("goal_id", "checkin_date", name="uq_habit_checkin_goal_date"),
        Index("ix_habit_checkin_created", "created_at", "id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("habit_goals.id", ondelete="CASCADE"), nullable=False)
    checkin_date = Column(Date, nullable=False)
    content = Column(String(500), nullable=False, default="")
    # 打卡时的可见性是公开的必要条件；此后目标转私密也会收回访问。
    is_public = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)


class HabitImage(Base):
    __tablename__ = "habit_images"

    checkin_id = Column(UUID(as_uuid=True), ForeignKey("habit_checkins.id", ondelete="CASCADE"), primary_key=True)
    data = Column(LargeBinary, nullable=False)


class HabitFollow(Base):
    __tablename__ = "habit_follows"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    goal_id = Column(UUID(as_uuid=True), ForeignKey("habit_goals.id", ondelete="CASCADE"), primary_key=True, index=True)


class HabitLike(Base):
    __tablename__ = "habit_likes"

    checkin_id = Column(UUID(as_uuid=True), ForeignKey("habit_checkins.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)


class HabitComment(Base):
    __tablename__ = "habit_comments"
    __table_args__ = (Index("ix_habit_comment_checkin_created", "checkin_id", "created_at", "id"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    checkin_id = Column(UUID(as_uuid=True), ForeignKey("habit_checkins.id", ondelete="CASCADE"), nullable=False)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(String(500), nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
