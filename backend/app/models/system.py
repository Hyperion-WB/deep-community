import uuid
from datetime import datetime
from sqlalchemy import func, Column, String, Integer, BigInteger, Boolean, Text, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, INET
from app.core.database import Base
from app.core.timezone import utc_now

class Notification(Base):
    __tablename__ = "notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    receiver_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # 匿名行为时此字段在数据层强制置空，彻底防止 UID 抓包泄露
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    
    # comment / reply / like_post / like_comment / mention / level_up / system
    action_type = Column(String(32), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=True)
    comment_id = Column(UUID(as_uuid=True), nullable=True)
    brief = Column(String(255), nullable=False)
    is_read = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

class Report(Base):
    """前台一键举报表"""
    __tablename__ = "reports"

    # SQLite 只有 INTEGER PRIMARY KEY 才会自增；BIGINT 主键会导致插入失败（NOT NULL constraint）
    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    reporter_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # post / comment
    target_type = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    
    # spam (广告), attack (人身攻击), illegal (违法), privacy (侵权/隐私), other (其他)
    reason_type = Column(String(32), nullable=False)
    description = Column(String(200), default="")
    
    # pending (待审), resolved (已处罚), rejected (已驳回)
    status = Column(String(16), nullable=False, default="pending", index=True)
    resolved_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    resolve_note = Column(Text, default="")
    # v2：举报截图 / 处置完成时间
    image_url = Column(String(512), nullable=True)
    handled_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

class SensitiveWord(Base):
    """动态维护敏感词库"""
    __tablename__ = "sensitive_words"

    id = Column(Integer, primary_key=True, autoincrement=True)
    word = Column(String(100), unique=True, nullable=False, index=True)
    category = Column(String(50), default="general")
    # block (拒绝), replace (替换***), warn (仅记录)
    action = Column(String(16), nullable=False, default="block")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

class SiteAnnouncement(Base):
    """全站公告与更新日志 (支持富文本/Markdown、标题、严重级别与历史归档)"""
    __tablename__ = "site_announcements"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(200), nullable=False, default="")
    content = Column(Text, nullable=False)
    level = Column(String(16), nullable=False, default="info") # info, update, warning
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

class AdminAuditLog(Base):
    """管理员特权穿透审计日志 (解密匿名身份时必须记录)"""
    __tablename__ = "admin_audit_logs"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    # 管理员账号被删除后审计日志必须保留（追溯责任），因此 SET NULL 而非级联删除
    admin_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    target_comment_id = Column(UUID(as_uuid=True), nullable=True)
    target_real_user_id = Column(UUID(as_uuid=True), nullable=False)
    reason = Column(Text, nullable=False)
    ip_address = Column(String(45), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

class SystemSetting(Base):
    """系统全局运行配置表（由超级管理员动态调控）"""
    __tablename__ = "system_settings"

    key = Column(String(64), primary_key=True)
    # AI Key / 长文本配置需要超过 255
    value = Column(Text, nullable=False)
    description = Column(String(255), default="")
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now,
                        server_default=func.now(), nullable=False)

class CommunityRule(Base):
    """社区公约与入站必读配置 (由超级管理员/管理员维护，全员可见)"""
    __tablename__ = "community_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(200), nullable=False, default="极客社区自治公约与入站必读规范")
    content = Column(Text, nullable=False)
    version = Column(Integer, nullable=False, default=1)
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now,
                        server_default=func.now(), nullable=False)

class CommunityEndorsement(Base):
    """用户对社区公约的表态与承诺签署"""
    __tablename__ = "community_endorsements"

    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    stance = Column(String(64), nullable=False, default="pledge")  # pledge: 承诺恪守, support: 认同支持
    comment = Column(String(255), nullable=False, default="恪守极客自治公约，共同守护纯粹交流空间")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)


class SiteContent(Base):
    """静态页面内容（如免责与法律声明），支持后台在线编辑 Markdown。"""
    __tablename__ = "site_contents"

    key = Column(String(32), primary_key=True)
    title = Column(String(200), nullable=False, default="")
    content = Column(Text, nullable=False, default="")
    updated_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now,
                        server_default=func.now(), nullable=False)
