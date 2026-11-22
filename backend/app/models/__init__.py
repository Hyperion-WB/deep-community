from app.core.database import Base
from app.models.user import User, Checkin, InviteCode
from app.models.post import Category, Post, PostEdit, PostImage, Like, Collection, PostSeries, SeriesItem
from app.models.comment import Comment
from app.models.poll import Poll, PollOption, PollVote
from app.models.chat import Conversation, Message, GroupRoom, GroupMessage, GroupMember, GroupJoinRequest, GroupAuditLog
from app.models.system import (
    Notification,
    Report,
    SensitiveWord,
    SiteAnnouncement,
    AdminAuditLog,
    SystemSetting,
    CommunityRule,
    CommunityEndorsement,
)
from app.models.feedback import Feedback, FeedbackUpvote
from app.models.reaction import Reaction
from app.models.ops import SiteVisit, SiteMetricDaily
from app.models.achievement import AchievementDef, UserAchievement
from app.models.qa import QaQuestion, ExpLedger, QaExtraQuota, QaAnswer
from app.models.group_activity import (
    IdiomChainGame,
    FeihuaGame,
    DailyFortuneDraw,
    GroupPoll,
    GroupPollOption,
    GroupPollVote,
)
from app.models.friend_link import FriendLink
from app.models.sticker import UserSticker

__all__ = [
    "Base",
    "User",
    "Checkin",
    "InviteCode",
    "Category",
    "Post",
    "PostEdit",
    "PostImage",
    "Like",
    "Collection",
    "Comment",
    "Poll",
    "PollOption",
    "PollVote",
    "Conversation",
    "Message",
    "GroupRoom",
    "GroupMessage",
    "GroupMember",
    "GroupJoinRequest",
    "GroupAuditLog",
    "Notification",
    "Report",
    "SensitiveWord",
    "SiteAnnouncement",
    "AdminAuditLog",
    "SystemSetting",
    "CommunityRule",
    "CommunityEndorsement",
    "Feedback",
    "FeedbackUpvote",
    "Reaction",
    "SiteVisit",
    "SiteMetricDaily",
    "AchievementDef",
    "UserAchievement",
    "FriendLink",
    "UserSticker",
    "FeihuaGame",
]

from app.models import game_platform  # noqa: F401  注册 404 游戏平台模型
