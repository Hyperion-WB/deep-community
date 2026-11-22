import uuid
from datetime import datetime, date
from sqlalchemy import Boolean, Column, String, Integer, SmallInteger, Boolean, Date, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.core.timezone import utc_now

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 基础身份与资料 (用户名不可更改，昵称每月限改3次)
    username = Column(String(32), unique=True, nullable=False, index=True)
    nickname = Column(String(32), nullable=True)
    nickname_change_count = Column(Integer, nullable=False, default=0)
    nickname_last_change_month = Column(String(7), nullable=True) # YYYY-MM
    # 额外昵称修改额度：管理员在「用户管理」页对其执行重置（密码/头像/昵称）后 +1，
    # 即使当月 3 次自然额度已用完，也能再改一次；用一次扣一次，不随自然月清零。
    nickname_extra_quota = Column(Integer, nullable=False, default=0, server_default="0")
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    avatar_url = Column(String(500), default=None, nullable=True)
    bio = Column(String(200), default="")
    equipped_title = Column(String(64), nullable=True, default=None)
    # 免打扰偏好（群 id / 会话 id），云端存储以便多端同步
    muted_chats = Column(JSONB, nullable=False, default=dict)
    gender = Column(String(16), default="secret", nullable=False) # male, female, other, secret
    tech_stack = Column(String(255), default="", nullable=False) # 逗号分隔技术标签，如 Python,React,Docker
    github_url = Column(String(255), default="", nullable=False) # GitHub 主页或用户名
    blog_url = Column(String(255), default="", nullable=False) # 个人独立博客或站点链接
    ip_location = Column(String(64), default="", nullable=False) # IP 归属地 (根据登录/发帖自动识别)

    # 角色: admin (超管), user (普通)
    role = Column(String(16), nullable=False, default="user")
    # 机器人账号（AI 自动评论使用）：不能登录、不计入榜单
    is_bot = Column(Boolean, nullable=False, default=False, server_default="false")
    # 状态: probation (见习), active (正式), banned (封禁), deleting (注销缓冲期)
    status = Column(String(16), nullable=False, default="probation")
    # 进入注销缓冲期前的状态，用于超级管理员一键恢复
    status_before_deletion = Column(String(16), nullable=True)
    # 注销缓冲期：申请时间与预计彻底清除时间（默认 10 天）
    deletion_requested_at = Column(DateTime(timezone=True), nullable=True)
    purge_after = Column(DateTime(timezone=True), nullable=True, index=True)
    # 注册途径: invite (邀请码), public (公开), github (OAuth)
    register_channel = Column(String(16), nullable=False, default="public")
    # GitHub OAuth 绑定 ID（自助注销等场景登录依据，未绑定为 NULL）
    github_id = Column(String(32), nullable=True, unique=True, index=True)
    # Gitee OAuth 绑定 ID
    gitee_id = Column(String(32), nullable=True, unique=True, index=True)
    # 邮箱验证状态：公开注册必须通过邮箱验证码；OAuth 注册以平台已验证邮箱为准
    email_verified = Column(Boolean, nullable=False, default=False, server_default="false")
    email_verified_at = Column(DateTime(timezone=True), nullable=True)
    # 最近一次换绑邮箱时间：用于 30 天冷却，防止账号被盗后快速改邮箱再重置密码
    email_changed_at = Column(DateTime(timezone=True), nullable=True)
    # 令牌版本号：改密/封禁时自增，使此前签发的所有 access/refresh 令牌立即失效
    token_version = Column(Integer, nullable=False, default=0, server_default="0")
    # 首次部署使用默认口令时为 True：除改密/自查/登出外，所有需要登录的接口一律拒绝
    must_change_password = Column(Boolean, nullable=False, default=False, server_default="false")
    
    # 等级与活跃体系
    experience = Column(Integer, nullable=False, default=0)
    level = Column(SmallInteger, nullable=False, default=0) # 0 ~ 6
    active_days = Column(Integer, nullable=False, default=1)
    last_active_date = Column(Date, default=date.today)
    today_exp_gained = Column(Integer, nullable=False, default=0) # 今日已获取经验（受每日获取上限限制）
    today_exp_date = Column(Date, default=date.today) # 今日经验统计归属日期
    
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    dnd_enabled = Column(Boolean, nullable=False, default=False) # 免打扰模式: 拒收陌生人私信并静默通知
    hide_following = Column(Boolean, nullable=False, default=False) # 隐私: 隐藏关注名单
    hide_followers = Column(Boolean, nullable=False, default=False) # 隐私: 隐藏粉丝名单
    hide_favorites = Column(Boolean, nullable=False, default=False) # 隐私: 隐藏收藏列表
    hide_ip_location = Column(Boolean, nullable=False, default=False) # 隐私: 隐藏 IP 属地
    hide_online_status = Column(Boolean, nullable=False, default=False) # 隐私: 隐藏在线状态（关闭后他人看到的是离线）
    # 偏好：点击文章时在新标签页打开（默认关闭，随账号同步）
    open_post_in_new_tab = Column(Boolean, nullable=False, default=False, server_default="false")
    # 默认门户界面：classic 经典版 / pro 专业版，随账号长期保存（默认经典版）
    portal_mode = Column(String(16), nullable=False, default="classic", server_default="classic")

    # 关联
    checkins = relationship("Checkin", back_populates="user", cascade="all, delete-orphan")
    posts = relationship("Post", back_populates="author", cascade="all, delete-orphan")
    comments = relationship("Comment", back_populates="author", cascade="all, delete-orphan", foreign_keys="Comment.author_id")

class UserSession(Base):
    """登录会话（一台设备一行），id 即 refresh token 的 jti。

    用途：登录设备列表、单设备下线、全部其他设备下线。
    吊销只影响 refresh（最长 7 天），access token 仍按自身 2 小时有效期自然过期。
    """
    __tablename__ = "user_sessions"

    id = Column(String(64), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device = Column(String(120), nullable=False, default="")
    ip = Column(String(64), nullable=False, default="")
    user_agent = Column(String(400), nullable=False, default="")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    last_active_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)


class Follow(Base):
    """用户关注关系表"""
    __tablename__ = "follows"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    follower_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    following_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("follower_id", "following_id", name="uq_follow_pair"),
    )

class UserBlock(Base):
    """用户黑名单关系表: blocker_id 拉黑了 blocked_id"""
    __tablename__ = "user_blocks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    blocker_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    blocked_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id", name="uq_user_block_pair"),
    )

class Checkin(Base):
    __tablename__ = "checkins"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    checkin_date = Column(Date, nullable=False)
    continuous_days = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    user = relationship("User", back_populates="checkins")

    __table_args__ = (
        UniqueConstraint("user_id", "checkin_date", name="uq_user_checkin_date"),
    )

class InviteCode(Base):
    __tablename__ = "invite_codes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code = Column(String(32), unique=True, nullable=False, index=True)
    generator_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    used_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    is_used = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

