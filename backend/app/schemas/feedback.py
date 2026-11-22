from typing import Optional, List
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field

class FeedbackCreateRequest(BaseModel):
    feedback_type: str = Field(..., pattern="^(bug|feature)$")
    title: str = Field(..., min_length=2, max_length=200)
    content: str = Field(..., min_length=5, max_length=5000)
    # 兼容旧客户端的单张截图
    image_url: Optional[str] = Field(None, max_length=512)
    # 最多 5 张截图（前端先上传拿到 /uploads/ 地址）
    image_urls: Optional[List[str]] = Field(None, max_length=5)
    # v2：子分区（由 /feedbacks/categories 下发，服务端不硬编码枚举）
    category: Optional[str] = Field(None, max_length=32)
    # 存草稿时不发布、不计 UP、不发经验
    is_draft: bool = False

class FeedbackDraftRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = Field(None, min_length=1, max_length=5000)
    category: Optional[str] = Field(None, max_length=32)
    feedback_type: Optional[str] = Field(None, pattern="^(bug|feature)$")
    image_url: Optional[str] = Field(None, max_length=512)
    image_urls: Optional[List[str]] = Field(None, max_length=5)

class FeedbackStatusUpdateRequest(BaseModel):
    # 状态白名单：此前任意字符串可直接入库，破坏 bug/feature 两套状态机展示
    status: str = Field(..., pattern=r"^(open|investigating|fixed|wontfix|pending|under_consideration|accepted|completed|declined)$")
    admin_reply: Optional[str] = Field(None, max_length=3000)

class FeedbackResponse(BaseModel):
    id: UUID
    feedback_type: str
    title: str
    content: str
    status: str
    upvotes_count: int
    has_upvoted: bool = False
    admin_reply: Optional[str] = None
    admin_replied_by_username: Optional[str] = None
    admin_replied_by_nickname: Optional[str] = None
    admin_replied_at: Optional[datetime] = None
    image_url: Optional[str] = None
    image_urls: List[str] = []
    user_confirm: str = ""
    user_confirm_at: Optional[datetime] = None
    user_note: Optional[str] = None
    # 当前访问者是否可以确认（本人 + 管理员已回复 + 尚未确认）
    can_confirm: bool = False
    author_id: UUID
    author_username: str
    author_nickname: Optional[str] = None
    author_avatar: Optional[str] = None
    author_level: int = 1
    created_at: datetime
    updated_at: datetime
    category: str = "other"
    is_draft: bool = False
    withdrawn_at: Optional[datetime] = None


class FeedbackConfirmRequest(BaseModel):
    """反馈者确认：Bug 已修复 / 仍复现，或建议已收到。"""
    confirm: str = Field(..., pattern=r"^(fixed|unfixed|received)$")
    note: Optional[str] = Field(None, max_length=500)
