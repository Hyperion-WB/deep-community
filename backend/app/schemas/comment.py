from typing import Optional, List
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, Field

class CommentCreateRequest(BaseModel):
    post_id: UUID
    content: str = Field(..., min_length=0, max_length=2000)
    parent_id: Optional[UUID] = None
    reply_to_user_id: Optional[UUID] = None
    is_anonymous: bool = False
    # 单条评论最多一张图：普通图片或自定义表情，二选一
    image_url: Optional[str] = Field(None, max_length=512)
    image_kind: Optional[str] = Field(None, pattern="^(photo|sticker)?$")

class CommentResponse(BaseModel):
    id: UUID
    post_id: UUID
    parent_id: Optional[UUID] = None
    content: str
    image_url: str = ""
    image_kind: str = ""
    is_anonymous: bool
    anonymous_alias: Optional[str] = None
    is_featured: bool
    is_accepted: bool = False
    like_count: int
    is_liked: bool = False
    is_deleted: bool = False
    created_at: datetime
    # 非匿名时有值；匿名时在序列化层被彻底抹去
    author_username: Optional[str] = None
    author_nickname: Optional[str] = None
    author_avatar: Optional[str] = None
    author_level: Optional[int] = None

    # 首屏只带前 2 条回复，这里给出总数，前端据此决定是否显示「展开全部」
    reply_total: int = 0

    replies: List["CommentResponse"] = []

CommentResponse.model_rebuild()
