import uuid

from sqlalchemy import Boolean, Column, DateTime, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func

from app.core.database import Base


class FriendLink(Base):
    """友情链接：站长手动添加，或后续由申请审核通过后入库。

    图标一律本地化存储（icon_url 指向本站 /uploads/...），
    直接引用对方站点的图标 URL 会把访客 IP 暴露给第三方，也容易被防盗链搞成裂图。
    """

    __tablename__ = "friend_links"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    site_name = Column(String(64), nullable=False)
    url = Column(String(512), nullable=False, unique=True)
    description = Column(String(200), nullable=False, default="")

    icon_url = Column(String(512), nullable=False, default="")
    # ok / failed：抓取失败时前端用「站名首字 + 色块」兜底，不影响展示
    icon_status = Column(String(16), nullable=False, default="pending")

    # approved（已上架）/ pending（待审核）/ rejected（已拒绝）
    status = Column(String(16), nullable=False, default="approved")

    # 申请来源：站内用户 id 或站外联系方式，站长手动添加时为空
    applicant_user_id = Column(UUID(as_uuid=True), nullable=True)
    applicant_contact = Column(String(120), nullable=False, default="")
    reject_reason = Column(String(200), nullable=False, default="")

    # 上次尝试抓取图标的时间：定时任务据此重试失败的图标
    icon_checked_at = Column(DateTime(timezone=True), nullable=True)

    sort_order = Column(Integer, nullable=False, default=0)
    visible = Column(Boolean, nullable=False, default=True)
    click_count = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
