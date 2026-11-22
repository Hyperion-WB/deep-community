import uuid
from sqlalchemy import (
    Column, String, Integer, SmallInteger, Boolean, DateTime, ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.dialects.postgresql import UUID
from app.core.database import Base
from app.core.timezone import utc_now


class AchievementDef(Base):
    """勋章 / 成就定义

    series 不为空表示它是「分级系列」中的某一档（tier 0~3 → 铜/银/金/钻）；
    custom=True 表示超级管理员自定义的勋章（code 以 custom_ 开头）。
    """

    __tablename__ = "achievement_defs"

    code = Column(String(64), primary_key=True)
    name = Column(String(32), nullable=False)
    subtitle = Column(String(48), default="")
    description = Column(String(200), default="")
    # 图标：直接存 emoji，自定义勋章也能用（如 🏆 / 🧪 / 🐛）
    icon = Column(String(16), default="🏅")
    category = Column(String(16), nullable=False, default="misc")  # series / special / custom
    series = Column(String(32), nullable=True)
    tier = Column(SmallInteger, nullable=False, default=0)  # 0 铜 1 银 2 金 3 钻
    target = Column(Integer, nullable=False, default=0)  # 分级系列的达成阈值
    hidden = Column(Boolean, nullable=False, default=False)  # 隐藏类成就：未解锁时不展示
    custom = Column(Boolean, nullable=False, default=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    active = Column(Boolean, nullable=False, default=True)
    sort = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        Index("ix_achievement_defs_series", "series", "tier"),
        Index("ix_achievement_defs_category", "category"),
    )


class UserAchievement(Base):
    """用户已获得的勋章（同一勋章只保留最高等级的一条记录）"""

    __tablename__ = "user_achievements"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    code = Column(String(64), ForeignKey("achievement_defs.code", ondelete="CASCADE"), nullable=False, index=True)
    tier = Column(SmallInteger, nullable=False, default=0)
    progress = Column(Integer, nullable=False, default=0)
    reason = Column(String(200), default="")
    granted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    unlocked_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("user_id", "code", name="uq_user_achievement"),
    )
