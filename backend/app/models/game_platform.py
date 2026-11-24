"""404 游戏平台：注册中心 / 赛季积分 / 反作弊 / 对战。"""
import uuid as _uuid

from sqlalchemy import Text, BigInteger, text, Boolean, Column, Date, DateTime, Float, ForeignKey, Integer,     JSON, Numeric, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base
from app.core.timezone import utc_now


class GameDef(Base):
    __tablename__ = "game_defs"

    code = Column(String(32), primary_key=True)
    name = Column(String(64), nullable=False)
    zone = Column(String(8), nullable=False, default="solo")
    engine = Column(String(16), nullable=False, default="iframe")
    path = Column(String(128), nullable=False, default="")
    difficulty = Column(Numeric(4, 2), nullable=False, default=1.0)
    target_score = Column(Integer, nullable=False, default=1000)
    ref_seconds = Column(Integer, nullable=False, default=120)
    enabled = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    sort_order = Column(Integer, nullable=False, default=0, server_default=text("0"))
    source_license = Column(String(64), nullable=False, default="")


class GameRun(Base):
    """一局一凭证：服务端签发 run_id，上报分数必须绑定且只能结算一次。"""
    __tablename__ = "game_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    game = Column(String(32), nullable=False)
    seed = Column(String(64), nullable=False, default="")
    started_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    duration_ms = Column(Integer, nullable=False, default=0)
    raw_score = Column(Integer, nullable=False, default=0)
    completed = Column(Boolean, nullable=False, default=False)
    difficulty = Column(Numeric(4, 2), nullable=False, default=1.0)
    settled = Column(Boolean, nullable=False, default=False)
    payload = Column(JSON, nullable=False, default=dict)


class SeasonScore(Base):
    """每用户每游戏每赛季的 0-100 赛季分（只升不降）。"""
    __tablename__ = "season_scores"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    season_id = Column(String(7), nullable=False)
    game = Column(String(32), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    season_score = Column(Integer, nullable=False, default=0)
    # 未截断的精确分（season_score*1000 量级），用于同分时的确定性次级排序
    tiebreak = Column(Integer, nullable=False, default=0, server_default=text("0"))
    best_raw = Column(Integer, nullable=False, default=0)
    runs = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (UniqueConstraint("season_id", "game", "user_id", name="uq_season_score"),)


class DouDizhuCheckIn(Base):
    """斗地主每日签到奖励，按账号和站点自然日去重。"""
    __tablename__ = "doudizhu_check_ins"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    check_in_day = Column(Date, primary_key=True, index=True)
    reward = Column(Integer, nullable=False)


class SeasonSnapshot(Base):
    """赛季结算归档，供历史总榜回看。"""
    __tablename__ = "game_points_snapshots"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    season_id = Column(String(7), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    total_score = Column(Numeric(6, 2), nullable=False, default=0)
    breakdown = Column(JSON, nullable=False, default=dict)
    rank = Column(Integer, nullable=False, default=0)
    settled_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (UniqueConstraint("season_id", "user_id", name="uq_season_snapshot"),)


class SeasonRegistry(Base):
    __tablename__ = "season_registry"

    season_id = Column(String(7), primary_key=True)
    starts_at = Column(DateTime(timezone=True), nullable=False)
    ends_at = Column(DateTime(timezone=True), nullable=False)
    settled_at = Column(DateTime(timezone=True), nullable=True)
    status = Column(String(16), nullable=False, default="active")


class BattleMatch(Base):
    """回合制棋类对局：board_state 是服务端权威快照，客户端只提交走子意图。"""
    __tablename__ = "battle_matches"

    id = Column(UUID(as_uuid=True), primary_key=True, default=_uuid.uuid4)
    game_code = Column(String(32), nullable=False)
    inviter_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    invitee_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    status = Column(String(16), nullable=False, default="pending")
    board_state = Column(JSON, nullable=False, default=dict)
    move_seq = Column(Integer, nullable=False, default=0)
    turn_user_id = Column(UUID(as_uuid=True), nullable=True)
    winner_id = Column(UUID(as_uuid=True), nullable=True)
    result = Column(String(16), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    inviter_hidden_at = Column(DateTime(timezone=True), nullable=True)
    invitee_hidden_at = Column(DateTime(timezone=True), nullable=True)


class BattleMove(Base):
    __tablename__ = "battle_moves"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    match_id = Column(UUID(as_uuid=True), ForeignKey("battle_matches.id", ondelete="CASCADE"), nullable=False)
    seq = Column(Integer, nullable=False)
    actor_id = Column(UUID(as_uuid=True), nullable=False)
    payload = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (UniqueConstraint("match_id", "seq", name="uq_battle_move_seq"),)


class BattleSeasonStat(Base):
    __tablename__ = "battle_season_stats"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    season_id = Column(String(7), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    wins = Column(Integer, nullable=False, default=0)
    losses = Column(Integer, nullable=False, default=0)
    draws = Column(Integer, nullable=False, default=0)
    current_streak = Column(Integer, nullable=False, default=0)
    best_streak = Column(Integer, nullable=False, default=0)

    __table_args__ = (UniqueConstraint("season_id", "user_id", name="uq_battle_season_stat"),)


class AICommentLog(Base):
    """AI 自动评论硬幂等：一篇帖子只允许占位一次（主键冲突即跳过）。

    与「查询 AI 是否已评论」相比，这张表能在多 worker / 重复扫描 / 评论被
    删除后重扫等所有情况下保证「一帖一条、绝不重复」。"""
    __tablename__ = "ai_comment_log"

    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True)
    comment_id = Column(UUID(as_uuid=True), nullable=True)
    # 尝试次数与最后一次失败原因：连续失败 3 次的帖子会被放弃，避免卡住整批
    attempts = Column(Integer, nullable=False, default=0, server_default="0")
    last_error = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
