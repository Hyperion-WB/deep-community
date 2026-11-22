import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, SmallInteger, Boolean, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.core.database import Base
from app.core.timezone import utc_now

class Poll(Base):
    __tablename__ = "polls"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_id = Column(UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), unique=True, nullable=False)
    title = Column(String(200), nullable=False)
    is_multiple = Column(Boolean, nullable=False, default=False)
    max_choices = Column(SmallInteger, nullable=False, default=1)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    post = relationship("Post", back_populates="poll")
    options = relationship("PollOption", back_populates="poll", cascade="all, delete-orphan")
    votes = relationship("PollVote", back_populates="poll", cascade="all, delete-orphan")

class PollOption(Base):
    __tablename__ = "poll_options"

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(UUID(as_uuid=True), ForeignKey("polls.id", ondelete="CASCADE"), nullable=False, index=True)
    option_text = Column(String(100), nullable=False)
    vote_count = Column(Integer, nullable=False, default=0)

    poll = relationship("Poll", back_populates="options")

class PollVote(Base):
    __tablename__ = "poll_votes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    poll_id = Column(UUID(as_uuid=True), ForeignKey("polls.id", ondelete="CASCADE"), nullable=False, index=True)
    option_id = Column(Integer, ForeignKey("poll_options.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    poll = relationship("Poll", back_populates="votes")

    __table_args__ = (
        UniqueConstraint("poll_id", "option_id", "user_id", name="uq_user_poll_vote"),
    )
