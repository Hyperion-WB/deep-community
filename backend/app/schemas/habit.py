from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, StringConstraints


Visibility = Literal["public", "private"]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]
CommentText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class GoalCreate(BaseModel):
    title: Title
    description: Description = ""
    visibility: Visibility = "private"


class GoalUpdate(BaseModel):
    title: Title | None = None
    description: Description | None = None
    visibility: Visibility | None = None


class CommentCreate(BaseModel):
    content: CommentText


class HabitUserView(BaseModel):
    id: UUID
    username: str
    nickname: str | None
    avatar_url: str | None


class GoalView(BaseModel):
    id: UUID
    owner: HabitUserView
    title: str
    description: str
    visibility: Visibility
    current_streak: int
    longest_streak: int
    checked_in_today: bool
    is_following: bool
    created_at: datetime


class EntryView(BaseModel):
    id: UUID
    goal: GoalView
    checkin_date: date
    content: str
    has_image: bool
    liked: bool
    like_count: int
    comment_count: int
    created_at: datetime


class CommentView(BaseModel):
    id: UUID
    author: HabitUserView
    content: str
    can_delete: bool
    created_at: datetime


class FollowView(BaseModel):
    is_following: bool


class LikeView(BaseModel):
    liked: bool
    like_count: int


class RankView(BaseModel):
    rank: int
    goal: GoalView
