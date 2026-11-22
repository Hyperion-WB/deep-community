import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Boolean, Text, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, TSVECTOR, JSONB
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.core.timezone import utc_now

class Category(Base):
    __tablename__ = "categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(50), unique=True, nullable=False)
    slug = Column(String(50), unique=True, nullable=False, index=True)
    description = Column(String(200), default="")
    icon = Column(String(100), default="")
    sort_order = Column(Integer, default=0)

    posts = relationship("Post", back_populates="category")

class Post(Base):
    __tablename__ = "posts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    category_id = Column(Integer, ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True)
    
    title = Column(String(200), nullable=False)
    content_md = Column(Text, nullable=False)
    content_html = Column(Text, nullable=False)
    # 正文格式：markdown（默认） / plain（纯文本，换行原样保留）
    content_type = Column(String(16), nullable=False, default="markdown", server_default="markdown")
    cover_image = Column(String(500), nullable=True)
    # 九宫格多图：按用户排列顺序存 URL 列表（最多 10 张）
    image_urls = Column(JSONB, nullable=True)
    
    # 类型: post (普通交流), news (官方新闻早报)
    post_type = Column(String(16), nullable=False, default="post", index=True)
    # 好文分享：original（原创）/ repost（转载）；转载必须填来源
    source_type = Column(String(16), nullable=True)
    source_note = Column(String(500), nullable=True)
    # 状态: draft (草稿), scheduled (定时发布), published (已发布), deleted (已删除)
    status = Column(String(16), nullable=False, default="published", index=True)
    # 评论区策略: open (全开), member_only (仅正式会员), closed (关闭)
    comment_policy = Column(String(16), nullable=False, default="open")
    tags = Column(String(255), default="", nullable=True)
    
    is_pinned = Column(Boolean, nullable=False, default=False, index=True)
    is_essence = Column(Boolean, nullable=False, default=False, index=True) # 精华贴 / 推荐标识 (Staff Pick)
    accepted_comment_id = Column(UUID(as_uuid=True), nullable=True) # 采纳的最佳解答评论 ID
    scheduled_at = Column(DateTime(timezone=True), nullable=True)
    
    # 统计冗余
    view_count = Column(Integer, nullable=False, default=0)
    like_count = Column(Integer, nullable=False, default=0)
    comment_count = Column(Integer, nullable=False, default=0)
    collect_count = Column(Integer, nullable=False, default=0)
    
    search_vector = Column(TSVECTOR, nullable=True)
    
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    # 首次公开发布的时间戳；草稿↔发布反复横跳时不重置，用于只奖励一次经验
    first_published_at = Column(DateTime(timezone=True), nullable=True)
    # 当前发布或定时相册首次占用周配额的时间；历史帖子回退到 created_at
    album_quota_at = Column(DateTime(timezone=True), nullable=True)

    # 关联
    author = relationship("User", back_populates="posts")
    category = relationship("Category", back_populates="posts")
    comments = relationship("Comment", back_populates="post", cascade="all, delete-orphan")
    edits = relationship("PostEdit", back_populates="post", cascade="all, delete-orphan")
    poll = relationship("Poll", uselist=False, back_populates="post", cascade="all, delete-orphan")

class PostEdit(Base):
    """帖子历史编辑记录"""
    __tablename__ = "post_edits"

    id = Column(Integer, primary_key=True, autoincrement=True)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    editor_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    old_title = Column(String(200), nullable=False)
    old_content_md = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    post = relationship("Post", back_populates="edits")

class PostImage(Base):
    """上传图片状态机: 防止孤儿图片拖垮磁盘"""
    __tablename__ = "post_images"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="SET NULL"), nullable=True, index=True)
    uploader_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    storage_path = Column(String(500), nullable=False)
    file_size = Column(Integer, nullable=False)
    # temp (临时未绑定), attached (已发布绑定), deleted (标记清除)
    status = Column(String(16), nullable=False, default="temp", index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

class Like(Base):
    __tablename__ = "likes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # target_type: post / comment
    target_type = Column(String(16), nullable=False)
    target_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "target_type", "target_id", name="uq_user_like_target"),
    )

class Collection(Base):
    __tablename__ = "collections"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    group_name = Column(String(32), nullable=False, default="默认收藏")

    __table_args__ = (
        UniqueConstraint("user_id", "post_id", name="uq_user_post_collection"),
    )

class PostSeries(Base):
    """专栏 / 体系化文集合集"""
    __tablename__ = "post_series"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(100), nullable=False)
    description = Column(String(500), default="")
    cover_image = Column(String(500), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    items = relationship("SeriesItem", back_populates="series", cascade="all, delete-orphan", order_by="SeriesItem.sort_order")

class SeriesItem(Base):
    """专栏内章节文章关联"""
    __tablename__ = "series_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    series_id = Column(UUID(as_uuid=True), ForeignKey("post_series.id", ondelete="CASCADE"), nullable=False, index=True)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    sort_order = Column(Integer, default=0)

    series = relationship("PostSeries", back_populates="items")
    post = relationship("Post")

# 兼容性导入 re-export
from app.models.comment import Comment  # noqa: F401



class CollectionFolder(Base):
    """用户自建的收藏夹（可为空，收藏时不要求先有文章）。"""
    __tablename__ = "collection_folders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(32), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_user_collection_folder"),
    )
