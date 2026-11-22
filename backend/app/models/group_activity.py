import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, JSON, SmallInteger, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base
from app.core.timezone import utc_now


class IdiomChainGame(Base):
    """成语接龙单局状态：一个群同时只有一局进行中，状态集中在 state_json。"""
    __tablename__ = "idiom_chain_games"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="playing", index=True)  # playing / ended
    # {starter, current_char, used:[], entries:[{user_id,username,word,ok}], eliminated:[{...}], round}
    state_json = Column(JSON, nullable=False, default=dict)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)


class FeihuaGame(Base):
    """飞花令单局状态：一个群同时只有一局，状态集中在 state_json。

    state_json: {flag, flag_mode, duration_minutes, expires_at, starter, round,
                 used:[], entries:[{user_id,user,verse,info,ok,reason,ts}],
                 scores:{uid:{user,ok,wrong,first}}, skipped:[], result:{}}
    """
    __tablename__ = "feihua_games"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="playing", index=True)  # playing / ended
    # 冗余存令字，便于按令字统计/查询；判定仍以 state_json.flag 为准
    flag = Column(String(8), nullable=True, index=True)
    state_json = Column(JSON, nullable=False, default=dict)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)


class DailyFortuneDraw(Base):
    """每日求签流水：用于「每人每天限两次」的权威记账。"""
    __tablename__ = "daily_fortune_draws"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    draw_date = Column(String(10), nullable=False, index=True)  # 东八区 YYYY-MM-DD
    occurrence = Column(SmallInteger, nullable=False, default=1)
    tier = Column(String(16), nullable=False)
    result_json = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "draw_date", "occurrence", name="uq_daily_fortune"),
    )


class GroupPoll(Base):
    """群投票 / 问卷：仅群主或管理员可发起。"""
    __tablename__ = "group_polls"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    creator_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    is_multiple = Column(Boolean, nullable=False, default=False)
    max_choices = Column(SmallInteger, nullable=False, default=1)
    is_anonymous = Column(Boolean, nullable=False, default=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    closed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)


class GroupPollOption(Base):
    __tablename__ = "group_poll_options"

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(UUID(as_uuid=True), ForeignKey("group_polls.id", ondelete="CASCADE"), nullable=False, index=True)
    option_text = Column(String(200), nullable=False)
    sort_order = Column(SmallInteger, nullable=False, default=0)
    vote_count = Column(Integer, nullable=False, default=0)


class GroupPollVote(Base):
    """匿名投票仍存 user_id 用于去重，但接口永不下发。"""
    __tablename__ = "group_poll_votes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(UUID(as_uuid=True), ForeignKey("group_polls.id", ondelete="CASCADE"), nullable=False, index=True)
    option_id = Column(Integer, ForeignKey("group_poll_options.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("poll_id", "option_id", "user_id", name="uq_group_poll_vote"),
    )
