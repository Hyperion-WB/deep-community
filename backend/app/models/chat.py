import uuid
from datetime import datetime, timezone, date

def utc_now():
    return datetime.now(timezone.utc)

from sqlalchemy import Column, String, BigInteger, Boolean, Text, DateTime, Date, SmallInteger, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from app.core.database import Base

class Conversation(Base):
    """双人私聊会话表: 强制 user_small_id < user_big_id 保证会话唯一"""
    __tablename__ = "conversations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_small_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    user_big_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    last_message_preview = Column(String(255), default="")
    last_message_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    # 单方软删除：删除会话只对操作者隐藏，绝不连带删除对方的聊天记录
    user_small_deleted_at = Column(DateTime(timezone=True), nullable=True)
    user_big_deleted_at = Column(DateTime(timezone=True), nullable=True)
    # 单方清空聊天记录：只隐藏该时间点之前对当前用户可见的消息，对方记录不受影响
    user_small_cleared_at = Column(DateTime(timezone=True), nullable=True)
    user_big_cleared_at = Column(DateTime(timezone=True), nullable=True)

    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")

    __table_args__ = (
        UniqueConstraint("user_small_id", "user_big_id", name="uq_conversation_user_pair"),
    )

class Message(Base):
    __tablename__ = "messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id = Column(UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 消息类型: text (文字), image (图片URL)
    msg_type = Column(String(16), nullable=False, default="text")
    content = Column(Text, nullable=False)
    
    # 全局递增序列号 (用于稳定排序与前端去重)
    # 注意: 该列不是主键，PostgreSQL/SQLite 都不会为其自动生成值，
    # 因此统一由应用层 (app/routers/chat.py::next_seq_id) 显式写入单调递增值。
    # 消息唯一性由主键 id 保证，seq_id 只作排序依据，故不设唯一约束（多实例下微秒级撞号不再导致落库失败）。
    seq_id = Column(BigInteger, nullable=True, index=True)
    is_read = Column(Boolean, nullable=False, default=False)
    # 引用回复（同 GroupMessage）：存快照，原消息撤回后引用块仍可读
    reply_to_id = Column(UUID(as_uuid=True), nullable=True)
    reply_sender = Column(String(64), nullable=False, default="")
    reply_snippet = Column(String(200), nullable=False, default="")
    is_recalled = Column(Boolean, nullable=False, default=False) # 2分钟内限时撤回
    
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

    conversation = relationship("Conversation", back_populates="messages")

class GroupRoom(Base):
    """多人群聊频道表"""
    __tablename__ = "group_rooms"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    description = Column(String(255), default="")
    avatar_url = Column(String(255), default="")
    creator_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    is_public = Column(Boolean, default=True)
    announcement = Column(Text, default="")
    announcement_updated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    # 群签到配置：签到语 / 每日次数 / 每次经验
    checkin_text = Column(String(32), nullable=False, default="签到", server_default="签到")
    # 打卡时间段：[{"name":"早上","start":"06:00","end":"11:00"}, ...]
    # 空数组表示不限时段（兼容旧群）
    checkin_slots = Column(JSONB, nullable=False, default=list, server_default="[]")
    checkin_times_per_day = Column(SmallInteger, nullable=False, default=1, server_default="1")
    # 单次签到经验全局固定 10，不提供配置
    checkin_exp = Column(Integer, nullable=False, default=10, server_default="10")

    creator = relationship("User", foreign_keys=[creator_id])
    messages = relationship("GroupMessage", back_populates="room", cascade="all, delete-orphan")
    members = relationship("GroupMember", back_populates="room", cascade="all, delete-orphan")
    join_requests = relationship("GroupJoinRequest", back_populates="room", cascade="all, delete-orphan")

class GroupMember(Base):
    """群聊成员关联表"""
    __tablename__ = "group_members"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(16), default="member") # owner / admin / member
    joined_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    # 最后阅读时间：用于计算群聊未读数 (为空时以 joined_at 作为起点)
    last_read_at = Column(DateTime(timezone=True), nullable=True)

    # ---- 禁言 ----
    muted_until = Column(DateTime(timezone=True), nullable=True)
    mute_reason = Column(String(200), nullable=True)

    # ---- 群聊独立等级 / 经验（与网站等级完全分离） ----
    group_exp = Column(Integer, nullable=False, default=0, server_default="0")
    group_level = Column(SmallInteger, nullable=False, default=1, server_default="1")
    today_msg_count = Column(Integer, nullable=False, default=0, server_default="0")
    today_exp_gained = Column(Integer, nullable=False, default=0, server_default="0")
    today_exp_date = Column(Date, nullable=True)
    interaction_count = Column(Integer, nullable=False, default=0, server_default="0")
    heat_score = Column(Integer, nullable=False, default=0, server_default="0")

    # ---- 铭牌 ----
    # 等级铭牌唯一由 group_level 决定，任何人都不可指定/授予。
    # special_badge_name：当前佩戴的特殊名牌名（NULL = 展示等级铭牌），
    # 特殊名牌本体存在 group_special_badges，一人可拥有多个、可随时收回。
    special_badge_name = Column(String(32), nullable=True)
    # 以下三列为历史兼容字段，新逻辑不再读写
    badge_id = Column(SmallInteger, nullable=True)
    custom_badge_name = Column(String(32), nullable=True)
    badge_mode = Column(String(10), nullable=False, default="level", server_default="level")

    room = relationship("GroupRoom", back_populates="members")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("room_id", "user_id", name="uq_group_room_user"),
    )

class GroupJoinRequest(Base):
    """群聊申请入群表"""
    __tablename__ = "group_join_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    reason = Column(String(255), default="")
    status = Column(String(16), default="pending", nullable=False) # pending, approved, rejected
    handled_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    room = relationship("GroupRoom", back_populates="join_requests")
    user = relationship("User", foreign_keys=[user_id])
    handler = relationship("User", foreign_keys=[handled_by])

class GroupMessage(Base):
    """群聊消息表"""
    __tablename__ = "group_messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    msg_type = Column(String(16), nullable=False, default="text")
    # 同 Message.seq_id：由应用层显式写入，用于稳定排序与分页
    seq_id = Column(BigInteger, nullable=True, index=True)
    is_recalled = Column(Boolean, nullable=False, default=False) # 消息撤回状态标识
    # 是否为 @全体成员 消息：用于按天统计管理员的 @全体成员 使用次数
    is_mention_all = Column(Boolean, nullable=False, default=False)
    # 引用回复：存被引用消息的 id 与「发送者 + 内容快照」。
    # 快照是为了原消息被撤回/删除后引用块仍能正常显示，不会变成空白。
    reply_to_id = Column(UUID(as_uuid=True), nullable=True)
    reply_sender = Column(String(64), nullable=False, default="")
    reply_snippet = Column(String(200), nullable=False, default="")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

    room = relationship("GroupRoom", back_populates="messages")
    sender = relationship("User", foreign_keys=[sender_id])


class GroupAnnouncement(Base):
    """群公告历史：每条公告独立成行，成员逐条确认已读。

    与旧版 GroupRoom.announcement（单条文本）并存：旧字段只作为兼容镜像，
    真正的“是否置顶”由当前用户是否已读该条决定。
    """
    __tablename__ = "group_announcements"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, nullable=False)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)
    # 软删除：群主/管理员删除历史公告后仍保留行，避免已读记录悬空
    is_deleted = Column(Boolean, nullable=False, default=False, server_default="false")
    deleted_at = Column(DateTime(timezone=True), nullable=True)
    deleted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    room = relationship("GroupRoom")
    author = relationship("User", foreign_keys=[created_by])


class GroupAnnouncementRead(Base):
    """群公告已读记录：成员点「确认已读」后写入，读过的公告不再置顶。"""
    __tablename__ = "group_announcement_reads"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    announcement_id = Column(UUID(as_uuid=True), ForeignKey("group_announcements.id", ondelete="CASCADE"), nullable=False, index=True)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    read_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("announcement_id", "user_id", name="uq_group_announcement_read"),
    )


class GroupAuditLog(Base):
    """群聊特权穿透审计日志

    记录站长/管理员在「非本群成员」的情况下对私密群执行的读写与管理动作，
    用于事后追溯谁在何时看过、动过别人的私密群数据。
    """
    __tablename__ = "group_audit_logs"

    # SQLite 只有 INTEGER PRIMARY KEY 才会自增，BIGINT 不会，故按方言降级为 Integer
    id = Column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    # 群解散后仍保留审计痕迹，因此只做 SET NULL 而非级联删除
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="SET NULL"), nullable=True, index=True)
    room_name = Column(String(100), default="")
    operator_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    action = Column(String(32), nullable=False)  # read_messages / list_members / kick / role / dissolve / approve
    target_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    detail = Column(String(255), default="")
    client_ip = Column(String(64), default="")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)

    operator = relationship("User", foreign_keys=[operator_id])
    target_user = relationship("User", foreign_keys=[target_user_id])



class GroupCheckin(Base):
    """群签到流水：按业务时区自然日 + 群 + 用户记账，控制每日次数。"""
    __tablename__ = "group_checkins"
    __table_args__ = (
        UniqueConstraint("room_id", "user_id", "checkin_date", "occurrence",
                         name="uq_group_checkin"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    checkin_date = Column(Date, nullable=False)
    occurrence = Column(SmallInteger, nullable=False, default=1)
    # 命中的时间段名（空串 = 该群未配置时间段）
    slot_name = Column(String(16), nullable=False, default="", server_default="")
    exp = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class GroupSpecialBadge(Base):
    """群特殊名牌：管理员/群主授予，可一人多个、可逐个收回。"""
    __tablename__ = "group_special_badges"
    __table_args__ = (
        UniqueConstraint("room_id", "user_id", "name", name="uq_group_special_badge"),
    )
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(32), nullable=False)
    granted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
