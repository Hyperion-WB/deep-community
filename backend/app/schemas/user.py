from typing import Optional
from uuid import UUID
from datetime import datetime, date
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

# 密码策略统一收敛到 core.password_policy，此处做转出以兼容既有导入路径。
# 规则只约束「新设置的密码」，登录仍然只做哈希比对，存量用户不受影响。
from app.core.password_policy import (  # noqa: F401  (PASSWORD_PATTERN 供外部引用)
    PASSWORD_PATTERN,
    MIN_PASSWORD_LENGTH,
    validate_password_strength,
    validate_password_against_identity,
)


class TokenSchema(BaseModel):
    access_token: str
    # refresh_token 已迁移到 HttpOnly Cookie（JS 不可读），此处仅为兼容老客户端保留，正常登录响应为 null
    refresh_token: Optional[str] = None
    token_type: str = "bearer"

class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=32, pattern=r"^[a-zA-Z0-9_\u4e00-\u9fa5]+$")
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=64)
    invite_code: Optional[str] = None # 选填: 填则为正式会员，不填为见习生
    email_code: Optional[str] = Field(None, min_length=4, max_length=8) # 注册邮箱验证码（开启邮箱验证时必填）
    captcha_token: Optional[str] = None  # Cloudflare Turnstile token

    @field_validator("password")
    @classmethod
    def _check_password(cls, v: str) -> str:
        return validate_password_strength(v)

    @model_validator(mode="after")
    def _check_password_identity(self):
        """密码里不能直接出现自己的用户名/邮箱前缀，这类组合最容易被猜中。"""
        validate_password_against_identity(self.password, self.username, str(self.email))
        return self


class EmailCodeRequest(BaseModel):
    """发送邮箱验证码：register 注册 / reset 重置密码 / bind_email 绑定新邮箱"""
    email: EmailStr
    purpose: str = Field(..., pattern="^(register|reset|bind_email)$")
    captcha_token: Optional[str] = None  # 频繁发信后由前端附带 Cloudflare Turnstile token


class PasswordForgotRequest(BaseModel):
    email: EmailStr
    captcha_token: Optional[str] = None  # 频繁发信后由前端附带 Cloudflare Turnstile token


class PasswordResetRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=4, max_length=8)
    new_password: str = Field(..., min_length=6, max_length=64)

    @field_validator("new_password")
    @classmethod
    def _check_new_password(cls, v: str) -> str:
        return validate_password_strength(v)

    @model_validator(mode="after")
    def _check_new_password_identity(self):
        validate_password_against_identity(self.new_password, "", str(self.email))
        return self


class BindEmailRequest(BaseModel):
    """更换/绑定邮箱：需先向新邮箱发送 bind_email 验证码"""
    email: EmailStr
    code: str = Field(..., min_length=4, max_length=8)

class LoginRequest(BaseModel):
    username_or_email: str
    password: str
    captcha_token: Optional[str] = None  # 连续密码错误后由前端附带

class RefreshTokenRequest(BaseModel):
    # 字段可选：令牌已迁到 HttpOnly Cookie，新客户端不再发送 body；
    # 保留该字段只为兼容旧客户端，缺省时由服务端从 Cookie 读取
    refresh_token: Optional[str] = None

class UserProfileResponse(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    email: str
    avatar_url: Optional[str] = None
    bio: str
    role: str
    status: str
    level: int
    experience: int
    active_days: int
    created_at: datetime
    remaining_anon_quota: int = 0
    remaining_nickname_changes: int = 3
    followers_count: int = 0
    following_count: int = 0
    posts_count: int = 0
    is_following: bool = False
    is_blocked: bool = False
    is_blocked_by: bool = False
    dnd_enabled: bool = False
    hide_following: bool = False
    hide_followers: bool = False
    hide_favorites: bool = False
    hide_ip_location: bool = False
    hide_online_status: bool = False
    open_post_in_new_tab: bool = False
    # 默认门户界面（classic / pro），随账号同步；游客与旧数据为 classic
    portal_mode: str = "classic"
    is_online: bool = False  # 90 秒内有认证活动；开启隐私隐藏时对他人恒为 False
    has_checked_in_today: bool = False
    equipped_title: Optional[str] = None
    continuous_checkin_days: int = 0
    likes_received_count: int = 0
    comments_count: int = 0
    gender: str = "secret"
    tech_stack: str = ""
    github_url: str = ""
    blog_url: str = ""
    ip_location: str = ""
    register_channel: str = "public"  # public / invite / github / gitee（前端据此决定注销确认方式）
    must_change_password: bool = False  # 默认口令未修改时为 true，前端据此弹出强制改密
    email_verified: bool = False  # 邮箱是否已通过验证码验证
    github_bound: bool = False    # 是否已绑定 GitHub
    gitee_bound: bool = False     # 是否已绑定 Gitee

class SessionItem(BaseModel):
    id: str
    device: str
    ip: str
    created_at: datetime
    last_active_at: datetime
    is_current: bool = False
    # 同一「设备 + IP」被合并后的登录次数（>1 表示重复登录过多次）
    session_count: int = 1


class BlockedUserItem(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    blocked_at: datetime

class DndUpdateRequest(BaseModel):
    dnd_enabled: bool

class PrivacyUpdateRequest(BaseModel):
    open_post_in_new_tab: Optional[bool] = None
    hide_following: Optional[bool] = None
    hide_followers: Optional[bool] = None
    hide_favorites: Optional[bool] = None
    hide_ip_location: Optional[bool] = None
    hide_online_status: Optional[bool] = None
    dnd_enabled: Optional[bool] = None

class PortalModeUpdateRequest(BaseModel):
    """设置默认门户界面，服务端持久化。"""
    portal_mode: str = Field(..., pattern="^(classic|pro)$")


class FollowUserItem(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    bio: str = ""
    level: int = 0
    role: str = "user"
    followers_count: int = 0
    following_count: int = 0
    is_following: bool = False
    # 搜索命中的字段来源：username / nickname / bio，前端据此展示"为什么匹配到这个人"
    match_type: str = ""
    # 在线状态（90 秒心跳）：关注/粉丝列表与搜索结果的头像绿点使用
    is_online: bool = False

class FollowListResponse(BaseModel):
    hidden: bool = False
    total: int = 0
    items: list[FollowUserItem] = []

class CheckinResponse(BaseModel):
    success: bool
    continuous_days: int
    exp_gained: int
    current_level: int

class UserUpdateRequest(BaseModel):
    nickname: Optional[str] = Field(None, min_length=1, max_length=32)
    bio: Optional[str] = Field(None, max_length=200)
    avatar_url: Optional[str] = Field(None, max_length=500)
    equipped_title: Optional[str] = Field(None, max_length=64)
    gender: Optional[str] = Field(None, max_length=16)
    tech_stack: Optional[str] = Field(None, max_length=255)
    github_url: Optional[str] = Field(None, max_length=255)
    blog_url: Optional[str] = Field(None, max_length=255)

class PasswordChangeRequest(BaseModel):
    old_password: str = Field(..., min_length=6)
    new_password: str = Field(..., min_length=6, max_length=64)

    @field_validator("new_password")
    @classmethod
    def _check_password(cls, v: str) -> str:
        return validate_password_strength(v)

class PasswordVerifyRequest(BaseModel):
    """仅需验证密码的高危操作（如自助注销），不涉及新密码规则"""
    password: str = Field(..., min_length=1)

class DeactivateRequest(BaseModel):
    """自助注销确认凭据：密码用户验密码；GitHub OAuth 用户输入用户名确认"""
    password: Optional[str] = Field(None, min_length=1)
    confirm_username: Optional[str] = Field(None, min_length=1, max_length=64)

class UserAdminListItem(BaseModel):
    id: UUID
    username: str
    nickname: Optional[str] = None
    email: str
    avatar_url: Optional[str] = None
    role: str
    status: str
    level: int
    experience: int

    active_days: int
    created_at: datetime
    last_login_at: Optional[datetime] = None
    # 注销缓冲期（status='deleting' 时有值，供后台展示剩余天数与恢复操作）
    status_before_deletion: Optional[str] = None
    deletion_requested_at: Optional[datetime] = None
    purge_after: Optional[datetime] = None

class RoleUpdateRequest(BaseModel):
    role: str = Field(..., pattern=r"^(super_admin|admin|moderator|auditor|user)$")

class StatusUpdateRequest(BaseModel):
    status: str = Field(..., pattern=r"^(active|probation|banned)$")

class LevelUpdateRequest(BaseModel):
    level: int = Field(..., ge=0, le=6)
    experience: Optional[int] = Field(None, ge=0)

class DeleteUserRequest(BaseModel):
    code: Optional[str] = Field(None, description="最高管理员四位数字验证码")
    password: Optional[str] = Field(None, description="最高管理员当前登录密码(选填)")


