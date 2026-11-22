import uuid
from sqlalchemy import Column, String, Integer, BigInteger, DateTime, Index
from sqlalchemy.dialects.postgresql import UUID
from app.core.database import Base
from app.core.timezone import utc_now


class SiteVisit(Base):
    """页面访问明细（仅超级管理员运维面板使用，默认保留 60 天）

    day 为「业务日」(Asia/Shanghai)，避免跨零点统计错位；
    visitor_hash 由 IP + UA + day 哈希得到，不落原始 IP，兼顾 UV 统计与隐私。
    """

    __tablename__ = "site_visits"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    day = Column(String(10), nullable=False, index=True)
    path = Column(String(255), nullable=False, default="/")
    kind = Column(String(16), nullable=False, default="page")  # page / api
    visitor_hash = Column(String(64), nullable=False)
    user_id = Column(UUID(as_uuid=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

    __table_args__ = (
        Index("ix_site_visits_day_kind", "day", "kind"),
        Index("ix_site_visits_day_visitor", "day", "visitor_hash"),
    )


class SiteMetricDaily(Base):
    """站点每日汇总指标（API 请求/错误/慢请求 + 内容存量快照）"""

    __tablename__ = "site_metrics_daily"

    day = Column(String(10), primary_key=True)
    api_requests = Column(BigInteger, nullable=False, default=0)
    api_errors = Column(BigInteger, nullable=False, default=0)
    api_slow = Column(BigInteger, nullable=False, default=0)
    api_duration_ms = Column(BigInteger, nullable=False, default=0)
    users_total = Column(BigInteger, nullable=False, default=0)
    posts_total = Column(BigInteger, nullable=False, default=0)
    comments_total = Column(BigInteger, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
