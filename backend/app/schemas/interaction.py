from typing import List, Optional
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field

# 投票相关
class PollOptionCreate(BaseModel):
    option_text: str = Field(..., min_length=1, max_length=100)

class PollCreateRequest(BaseModel):
    post_id: UUID
    title: str = Field(..., min_length=2, max_length=200)
    options: List[PollOptionCreate] = Field(..., min_length=2, max_length=8)
    is_multiple: bool = False
    max_choices: int = 1
    expires_in_days: int = 7

class PollOptionResponse(BaseModel):
    id: int
    option_text: str
    vote_count: int
    percentage: float = 0.0
    is_voted: bool = False

class PollDetailResponse(BaseModel):
    id: UUID
    title: str
    is_multiple: bool
    max_choices: int
    expires_at: datetime
    is_expired: bool
    total_votes: int
    has_voted: bool
    options: List[PollOptionResponse]

# 私聊相关
class MessageCreateRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=5000)
    client_msg_id: Optional[str] = None
    # 引用回复：被引用消息的 id（服务端据此生成快照）
    reply_to_message_id: Optional[UUID] = None

class MessageResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    sender_id: UUID
    msg_type: str
    content: str
    seq_id: Optional[int] = None
    is_read: bool
    is_recalled: bool
    created_at: datetime
    reply_to_id: Optional[UUID] = None
    reply_sender: str = ""
    reply_snippet: str = ""

class ConversationResponse(BaseModel):
    id: UUID
    peer_user_id: UUID
    peer_username: str
    peer_nickname: Optional[str] = None
    peer_avatar: Optional[str] = None
    last_message_preview: str
    last_message_at: datetime
    unread_count: int = 0
    is_blocked: bool = False
    is_blocked_by_peer: bool = False

# 举报相关
class ReportCreateRequest(BaseModel):
    target_type: str = Field(..., pattern="^(post|comment)$")
    target_id: UUID
    reason_type: str = Field(..., pattern="^(spam|attack|illegal|privacy|other)$")
    # 详细原因必填：不允许只选分类就提交，也不允许纯空白凑数
    description: str = Field(..., min_length=10, max_length=500)
    # 可选截图，只允许站内上传地址
    image_url: Optional[str] = Field(None, max_length=512)

# 群聊相关
class GroupRoomCreateRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=50)
    description: Optional[str] = Field(None, max_length=200)
    is_public: bool = True

class GroupRoomUpdateRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=50)
    description: Optional[str] = Field(None, max_length=200)
    announcement: Optional[str] = Field(None, max_length=2000)
    # 群头像：只有群主可以改（其他管理员即使传了也会被忽略）
    avatar_url: Optional[str] = Field(None, max_length=255)

class GroupRoomResponse(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = ""
    avatar_url: Optional[str] = ""
    creator_id: Optional[UUID] = None
    creator_username: Optional[str] = None
    is_public: bool = True
    announcement: Optional[str] = ""
    announcement_updated_at: Optional[datetime] = None
    member_count: int = 1
    is_member: bool = False
    my_role: Optional[str] = None
    has_pending_apply: bool = False
    unread_count: int = 0
    last_message_preview: Optional[str] = ""
    last_message_at: Optional[datetime] = None
    created_at: datetime

class GroupJoinApplyRequest(BaseModel):
    reason: Optional[str] = Field(None, max_length=200)

class GroupJoinRequestResponse(BaseModel):
    id: UUID
    room_id: UUID
    user_id: UUID
    username: str
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    level: int = 1
    reason: Optional[str] = ""
    status: str = "pending"
    created_at: datetime

class GroupMemberResponse(BaseModel):
    user_id: UUID
    username: str
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    level: int = 1
    role: str # owner / admin / member
    joined_at: datetime
    # 是否 AI 机器人（前端 @ 列表需要把它置顶）
    is_bot: bool = False
    group_level: int = 1
    group_exp: int = 0
    badge_id: Optional[int] = None
    badge_name: str = ""
    special_badge_name: Optional[str] = None
    badge_kind: str = "level"
    muted_until: Optional[datetime] = None

class GroupInviteRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)

class GroupKickRequest(BaseModel):
    user_id: UUID

class GroupMuteRequest(BaseModel):
    duration_minutes: int = Field(..., ge=1, le=43200)
    reason: Optional[str] = Field(None, max_length=200)


class GroupBadgeRequest(BaseModel):
    badge_id: Optional[int] = Field(None, ge=1, le=20)
    custom_name: Optional[str] = Field(None, max_length=32)
    mode: Optional[str] = Field(None, pattern="^(level|custom)$")


class CheckinSlotItem(BaseModel):
    name: str = Field(..., min_length=1, max_length=16)
    start: str = Field(..., min_length=4, max_length=5)
    end: str = Field(..., min_length=4, max_length=5)


class GroupCheckinConfigRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=32)
    # 兼容旧客户端，实际次数固定为 3、经验固定 10，由平台规则决定
    times_per_day: int = Field(3, ge=1, le=3)
    exp: int = Field(10, ge=0, le=100)
    slots: List[CheckinSlotItem] = Field(default_factory=list, max_length=5)


class GroupSpecialBadgeRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)


class GroupWearBadgeRequest(BaseModel):
    """special_id=None 表示佩戴等级铭牌。"""
    special_id: Optional[UUID] = None


class GroupBadgeModeRequest(BaseModel):
    mode: str = Field(..., pattern="^(level|custom)$")


class GroupMemberRoleRequest(BaseModel):
    role: str = Field(..., pattern="^(admin|member)$")


class GroupTransferOwnerRequest(BaseModel):
    """群主转让：把群主身份移交给指定成员，原群主降为管理员"""
    target_user_id: UUID

class GroupMessageResponse(BaseModel):
    id: UUID
    room_id: UUID
    sender_id: UUID
    sender_username: str
    sender_nickname: Optional[str] = None
    sender_avatar: Optional[str] = None
    sender_level: int = 1
    content: str
    msg_type: str = "text"
    seq_id: Optional[int] = None
    is_recalled: bool = False
    is_mention_all: bool = False
    created_at: datetime
    reply_to_id: Optional[UUID] = None
    reply_sender: str = ""
    reply_snippet: str = ""


# 群公告历史
class GroupAnnouncementCreateRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)


class GroupAnnouncementResponse(BaseModel):
    id: UUID
    room_id: UUID
    content: str
    created_by: Optional[UUID] = None
    created_by_username: Optional[str] = None
    created_by_nickname: Optional[str] = None
    created_at: datetime
    is_read: bool = False
    read_at: Optional[datetime] = None


class MentionAllQuotaResponse(BaseModel):
    limit: int = 10
    used: int = 0
    remaining: int = 10
    can_use: bool = False

