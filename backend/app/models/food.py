"""美食广场 / 午餐转盘。

- 美食帖是一条特殊的 Post（post_type=food_topic），卡片是它的二级内容；
- 点赞复用 likes 表（target_type=food_card），评论单独建表，避免污染帖子评论；
- 群午餐盘每天一份，冻结后可转盘，第二天自动换新。
"""
import uuid
from datetime import date as date_cls

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.core.database import Base
from app.core.timezone import utc_now


class FoodCard(Base):
    __tablename__ = "food_cards"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    topic_post_id = Column(
        UUID(as_uuid=True), ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    group_id = Column(
        UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="SET NULL"), nullable=True
    )

    dish_names = Column(JSONB, nullable=False, default=list)
    content = Column(Text, nullable=False, default="")
    image_urls = Column(JSONB, nullable=False, default=list)
    # lunch / dinner / other
    meal_type = Column(String(16), nullable=False, default="lunch", index=True)
    # spin（转盘晒卡）/ manual（直接发）
    source = Column(String(8), nullable=False, default="manual", index=True)

    like_count = Column(Integer, nullable=False, default=0)
    comment_count = Column(Integer, nullable=False, default=0)
    status = Column(String(8), nullable=False, default="visible", index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)


class FoodCardComment(Base):
    __tablename__ = "food_card_comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    card_id = Column(
        UUID(as_uuid=True), ForeignKey("food_cards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id = Column(
        UUID(as_uuid=True), ForeignKey("food_card_comments.id", ondelete="CASCADE"), nullable=True
    )
    content = Column(Text, nullable=False, default="")
    # 预制评论携带的精致表情资源 key（前端映射到本地图片）
    emoji_key = Column(String(32), nullable=True)
    like_count = Column(Integer, nullable=False, default=0)
    status = Column(String(8), nullable=False, default="visible")
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)


class LunchPool(Base):
    __tablename__ = "lunch_pools"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id = Column(
        UUID(as_uuid=True), ForeignKey("group_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    date = Column(Date, nullable=False, default=date_cls.today, index=True)
    # open（可加菜/可转）/ frozen（已开转）
    status = Column(String(8), nullable=False, default="open")
    freeze_at = Column(DateTime(timezone=True), nullable=True)
    # {"freeze_time": "11:30"}
    settings = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (UniqueConstraint("group_id", "date", name="uq_lunch_pool_group_date"),)


class LunchDish(Base):
    __tablename__ = "lunch_dishes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pool_id = Column(
        UUID(as_uuid=True), ForeignKey("lunch_pools.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name = Column(String(32), nullable=False)
    norm_name = Column(String(32), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("pool_id", "user_id", "norm_name", name="uq_lunch_dish_pool_user_name"),
    )


class LunchSpin(Base):
    __tablename__ = "lunch_spins"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pool_id = Column(
        UUID(as_uuid=True), ForeignKey("lunch_pools.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id = Column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    dish_id = Column(
        UUID(as_uuid=True), ForeignKey("lunch_dishes.id", ondelete="CASCADE"), nullable=False
    )
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False, index=True)


class WheelPreset(Base):
    """个人转盘配置（owner_type=user）；owner_type 预留 group 共享盘。"""

    __tablename__ = "wheel_presets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_type = Column(String(8), nullable=False, default="user")
    owner_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    name = Column(String(32), nullable=False, default="")
    options = Column(JSONB, nullable=False, default=list)
    is_default = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("owner_type", "owner_id", "name", name="uq_wheel_preset_owner_name"),
    )


# 预制快捷评论：文案 + 精致表情 key（前端 public/food-emoji/<key>.png）
QUICK_COMMENTS = [
    {"text": "看着真好吃", "emoji": "yum"},
    {"text": "我也吃这个", "emoji": "same"},
    {"text": "求店名！", "emoji": "please"},
    {"text": "这摆盘绝了", "emoji": "wow"},
    {"text": "明天就吃它", "emoji": "plan"},
    {"text": "香迷糊了", "emoji": "drool"},
    {"text": "深夜放毒", "emoji": "night"},
    {"text": "碳水快乐", "emoji": "carbs"},
]

DEFAULT_DISHES = [
    "番茄炒蛋", "青椒肉丝", "红烧肉", "宫保鸡丁", "鱼香肉丝", "麻婆豆腐",
    "糖醋里脊", "可乐鸡翅", "土豆炖牛肉", "蒜蓉西兰花", "酸辣土豆丝", "蛋炒饭",
]
