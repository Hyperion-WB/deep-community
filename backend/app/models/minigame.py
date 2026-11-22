"""404 小游戏分数（每人每游戏只保留最高分）。"""
from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base
from app.core.timezone import utc_now


class MinigameScore(Base):
    __tablename__ = "minigame_scores"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    game = Column(String(24), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    score = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("game", "user_id", name="uq_minigame_game_user"),
    )
