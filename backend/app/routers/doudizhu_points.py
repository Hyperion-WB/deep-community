"""斗地主签到积分。"""
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import SITE_TZ, utc_now
from app.models.game_platform import DouDizhuCheckIn
from app.models.user import User
from app.routers.deps import get_current_user

router = APIRouter(prefix="/doudizhu/points", tags=["斗地主"])
DAILY_REWARD = 10


class PointsStatus(BaseModel):
    points: int
    checkedIn: bool
    dailyReward: int = DAILY_REWARD


async def _points_status(db: AsyncSession, user_id: UUID, today: date) -> PointsStatus:
    points, check_ins_today = (await db.execute(
        select(
            func.coalesce(func.sum(DouDizhuCheckIn.reward), 0),
            func.count().filter(DouDizhuCheckIn.check_in_day == today),
        ).where(DouDizhuCheckIn.user_id == user_id)
    )).one()
    return PointsStatus(points=points, checkedIn=bool(check_ins_today))


@router.get("")
async def get_points(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PointsStatus:
    return await _points_status(db, user.id, utc_now().astimezone(SITE_TZ).date())


@router.post("/check-in")
async def check_in(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PointsStatus:
    today = utc_now().astimezone(SITE_TZ).date()
    while True:
        season = f"{today:%Y-%m}"
        await db.execute(
            text("SELECT pg_advisory_xact_lock_shared(hashtextextended(:key, 0))"),
            {"key": f"game-season:{season}"},
        )
        today = utc_now().astimezone(SITE_TZ).date()
        # 等锁期间跨月时，使用新月份的锁，避免在快照结算后写入旧赛季。
        if f"{today:%Y-%m}" == season:
            break

    await db.execute(insert(DouDizhuCheckIn).values(
        user_id=user.id, check_in_day=today, reward=DAILY_REWARD,
    ).on_conflict_do_nothing(index_elements=[DouDizhuCheckIn.user_id, DouDizhuCheckIn.check_in_day]))
    result = await _points_status(db, user.id, today)
    await db.commit()
    return result
