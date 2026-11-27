from datetime import date, timedelta
from io import BytesIO
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import and_, case, delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.timezone import SITE_TZ, utc_now
from app.models.habit import HabitCheckin, HabitComment, HabitFollow, HabitGoal, HabitImage, HabitLike
from app.models.user import User
from app.routers.deps import get_current_user
from app.schemas.habit import (
    CommentCreate, CommentView, EntryView, FollowView, GoalCreate, GoalUpdate, GoalView,
    HabitUserView, LikeView, RankView,
)
from app.services.sensitive_service import sensitive_filter

router = APIRouter(prefix="/habits", tags=["自律打卡"])
Db = Annotated[AsyncSession, Depends(get_db)]
Offset = Annotated[int, Query(ge=0)]
Limit = Annotated[int, Query(ge=1, le=100)]
_DISABLED = ("banned", "deactivated", "deleting")
_MAX_IMAGE_BYTES = 5 * 1024 * 1024


async def _habit_user(user: Annotated[User, Depends(get_current_user)]) -> User:
    if user.status == "deleting" or user.is_bot:
        raise HTTPException(403, "该账号不可使用自律打卡")
    return user


Viewer = Annotated[User, Depends(_habit_user)]


def _today() -> date:
    return utc_now().astimezone(SITE_TZ).date()


def _clean(text: str) -> str:
    if "\x00" in text:
        raise HTTPException(400, "文本包含无效字符")
    blocked, _, cleaned = sensitive_filter.scan(text)
    if blocked:
        raise HTTPException(400, "文本包含违规内容")
    return cleaned


def _visible_user():
    return and_(User.status.not_in(_DISABLED), User.is_bot.is_(False))


def _public_goal():
    return and_(HabitGoal.visibility == "public", _visible_user())


def _readable_checkin(viewer_id: UUID):
    return or_(
        HabitGoal.owner_id == viewer_id,
        and_(_public_goal(), HabitCheckin.is_public.is_(True)),
    )


def _stats(goal: HabitGoal, today: date, *, public: bool) -> tuple[int, int, bool]:
    if public:
        last, streak, longest = goal.public_last_date, goal.public_streak, goal.public_longest_streak
    else:
        last, streak, longest = goal.last_date, goal.streak, goal.longest_streak
    return streak if last in (today, today - timedelta(days=1)) else 0, longest, last == today


def _record_day(goal: HabitGoal, today: date, *, public: bool) -> None:
    yesterday = today - timedelta(days=1)
    goal.streak = goal.streak + 1 if goal.last_date == yesterday else 1
    goal.longest_streak = max(goal.longest_streak, goal.streak)
    goal.last_date = today
    if public:
        goal.public_streak = goal.public_streak + 1 if goal.public_last_date == yesterday else 1
        goal.public_longest_streak = max(goal.public_longest_streak, goal.public_streak)
        goal.public_last_date = today


def _user_view(user: User) -> HabitUserView:
    return HabitUserView(id=user.id, username=user.username, nickname=user.nickname, avatar_url=user.avatar_url)


def _goal_view(goal: HabitGoal, owner: User, following: bool, today: date, *, public: bool) -> GoalView:
    current, longest, done = _stats(goal, today, public=public)
    return GoalView(
        id=goal.id, owner=_user_view(owner), title=goal.title, description=goal.description,
        visibility=goal.visibility, current_streak=current, longest_streak=longest,
        checked_in_today=done, is_following=following, created_at=goal.created_at,
    )


def _following(viewer_id: UUID):
    return select(HabitFollow.goal_id).where(
        HabitFollow.goal_id == HabitGoal.id, HabitFollow.user_id == viewer_id,
    ).exists()


def _liked(viewer_id: UUID):
    return select(HabitLike.checkin_id).where(
        HabitLike.checkin_id == HabitCheckin.id, HabitLike.user_id == viewer_id,
    ).exists()


def _like_count():
    return select(func.count()).select_from(HabitLike).where(
        HabitLike.checkin_id == HabitCheckin.id,
    ).correlate(HabitCheckin).scalar_subquery()


def _comment_count():
    return select(func.count()).select_from(HabitComment).join(User, User.id == HabitComment.author_id).where(
        HabitComment.checkin_id == HabitCheckin.id, _visible_user(),
    ).correlate(HabitCheckin).scalar_subquery()


def _comment_view(comment: HabitComment, author: User, owner_id: UUID, viewer_id: UUID) -> CommentView:
    return CommentView(
        id=comment.id, author=_user_view(author), content=comment.content,
        can_delete=viewer_id in (comment.author_id, owner_id), created_at=comment.created_at,
    )


async def _owned_goal(goal_id: UUID, viewer_id: UUID, db: AsyncSession) -> HabitGoal:
    goal = await db.scalar(select(HabitGoal).where(
        HabitGoal.id == goal_id, HabitGoal.owner_id == viewer_id,
    ).with_for_update())
    if goal is None:
        raise HTTPException(404, "目标不存在")
    return goal


async def _checkin(checkin_id: UUID, viewer_id: UUID, db: AsyncSession, *, lock: bool = False):
    stmt = (select(HabitCheckin, HabitGoal)
            .join(HabitGoal, HabitGoal.id == HabitCheckin.goal_id)
            .join(User, User.id == HabitGoal.owner_id)
            .where(HabitCheckin.id == checkin_id, _readable_checkin(viewer_id)))
    if lock:
        stmt = stmt.with_for_update(of=HabitGoal)
    row = (await db.execute(stmt)).one_or_none()
    if row is None:
        raise HTTPException(404, "打卡不存在")
    return row


def _encode_image(raw: bytes) -> bytes:
    try:
        with Image.open(BytesIO(raw), formats=("JPEG", "PNG", "WEBP", "GIF")) as source:
            if source.width * source.height > 12_000_000:
                raise HTTPException(400, "图片分辨率过大")
            picture = ImageOps.exif_transpose(source)
            picture.thumbnail((1600, 1600))
            # 重编码为单帧且不保留 EXIF/定位，不按请求声明的 MIME 直接回放原文件。
            mode = "RGBA" if "A" in picture.getbands() or "transparency" in picture.info else "RGB"
            output = BytesIO()
            picture.convert(mode).save(output, format="WEBP", quality=85)
            return output.getvalue()
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError) as exc:
        raise HTTPException(400, "请上传有效的 JPG、PNG、WebP 或 GIF 图片") from exc


@router.get("/goals", response_model=list[GoalView])
async def my_goals(db: Db, viewer: Viewer):
    today = _today()
    goals = (await db.scalars(select(HabitGoal).join(User, User.id == HabitGoal.owner_id)
                            .where(HabitGoal.owner_id == viewer.id, _visible_user())
                            .order_by(HabitGoal.created_at.desc(), HabitGoal.id))).all()
    return [_goal_view(goal, viewer, False, today, public=False) for goal in goals]


@router.post("/goals", response_model=GoalView, status_code=201)
async def create_goal(payload: GoalCreate, db: Db, viewer: Viewer):
    goal = HabitGoal(owner_id=viewer.id, title=_clean(payload.title),
                     description=_clean(payload.description), visibility=payload.visibility)
    db.add(goal)
    await db.commit()
    return _goal_view(goal, viewer, False, _today(), public=False)


@router.patch("/goals/{goal_id}", response_model=GoalView)
async def update_goal(goal_id: UUID, payload: GoalUpdate, db: Db, viewer: Viewer):
    goal = await _owned_goal(goal_id, viewer.id, db)
    if payload.title is not None:
        goal.title = _clean(payload.title)
    if payload.description is not None:
        goal.description = _clean(payload.description)
    if payload.visibility is not None:
        goal.visibility = payload.visibility
    await db.commit()
    return _goal_view(goal, viewer, False, _today(), public=False)


@router.get("/feed", response_model=list[EntryView])
async def feed(db: Db, viewer: Viewer, scope: Literal["public", "mine", "following"] = "public",
               offset: Offset = 0, limit: Limit = 20):
    today = _today()
    following = _following(viewer.id)
    has_image = select(HabitImage.checkin_id).where(HabitImage.checkin_id == HabitCheckin.id).exists()
    stmt = (select(HabitCheckin, HabitGoal, User, following, has_image, _liked(viewer.id),
                   _like_count(), _comment_count())
            .join(HabitGoal, HabitGoal.id == HabitCheckin.goal_id)
            .join(User, User.id == HabitGoal.owner_id))
    if scope == "mine":
        stmt = stmt.where(HabitGoal.owner_id == viewer.id, _visible_user())
    else:
        stmt = stmt.where(_public_goal(), HabitCheckin.is_public.is_(True))
        if scope == "following":
            stmt = stmt.where(following)
    rows = (await db.execute(stmt.order_by(HabitCheckin.created_at.desc(), HabitCheckin.id.desc())
                             .offset(offset).limit(limit))).all()
    return [EntryView(
        id=entry.id, goal=_goal_view(goal, owner, follows, today, public=scope != "mine"),
        checkin_date=entry.checkin_date, content=entry.content, has_image=image, liked=liked,
        like_count=likes, comment_count=comments, created_at=entry.created_at,
    ) for entry, goal, owner, follows, image, liked, likes, comments in rows]


@router.post("/goals/{goal_id}/checkins", response_model=EntryView, status_code=201)
async def create_checkin(goal_id: UUID, db: Db, viewer: Viewer,
                         content: Annotated[str, Form(max_length=500)] = "",
                         image: Annotated[UploadFile | None, File()] = None):
    text = _clean(content.strip())
    image_bytes = None
    if image is not None:
        raw = await image.read(_MAX_IMAGE_BYTES + 1)
        if len(raw) > _MAX_IMAGE_BYTES:
            raise HTTPException(413, "图片不能超过 5 MiB")
        image_bytes = await run_in_threadpool(_encode_image, raw)

    # 目标行锁将同一目标的打卡、连续天数更新及隐私变更串行；唯一约束为最终保障。
    goal = await _owned_goal(goal_id, viewer.id, db)
    now = utc_now()
    today = now.astimezone(SITE_TZ).date()
    public = goal.visibility == "public"
    entry_id = await db.scalar(insert(HabitCheckin).values(
        goal_id=goal.id, checkin_date=today, content=text, is_public=public, created_at=now,
    ).on_conflict_do_nothing(constraint="uq_habit_checkin_goal_date").returning(HabitCheckin.id))
    if entry_id is None:
        raise HTTPException(409, "今天已打卡")
    if image_bytes is not None:
        db.add(HabitImage(checkin_id=entry_id, data=image_bytes))
    _record_day(goal, today, public=public)
    await db.commit()
    return EntryView(
        id=entry_id, goal=_goal_view(goal, viewer, False, today, public=False),
        checkin_date=today, content=text, has_image=image_bytes is not None, liked=False,
        like_count=0, comment_count=0, created_at=now,
    )


@router.get("/checkins/{checkin_id}/image", response_class=Response)
async def checkin_image(checkin_id: UUID, db: Db, viewer: Viewer):
    data = await db.scalar(select(HabitImage.data)
                           .join(HabitCheckin, HabitCheckin.id == HabitImage.checkin_id)
                           .join(HabitGoal, HabitGoal.id == HabitCheckin.goal_id)
                           .join(User, User.id == HabitGoal.owner_id)
                           .where(HabitCheckin.id == checkin_id, _readable_checkin(viewer.id), _visible_user()))
    if data is None:
        raise HTTPException(404, "图片不存在或不可见")
    return Response(data, media_type="image/webp", headers={
        "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff",
    })


async def _set_follow(goal_id: UUID, db: AsyncSession, viewer_id: UUID, *, enabled: bool) -> FollowView:
    goal = await db.scalar(select(HabitGoal).join(User, User.id == HabitGoal.owner_id).where(
        HabitGoal.id == goal_id, _public_goal(),
    ).with_for_update(of=HabitGoal))
    if goal is None:
        raise HTTPException(404, "目标不存在")
    if goal.owner_id == viewer_id:
        raise HTTPException(400, "不能关注自己的目标")
    if enabled:
        await db.execute(insert(HabitFollow).values(goal_id=goal_id, user_id=viewer_id).on_conflict_do_nothing())
    else:
        await db.execute(delete(HabitFollow).where(HabitFollow.goal_id == goal_id, HabitFollow.user_id == viewer_id))
    await db.commit()
    return FollowView(is_following=enabled)


@router.put("/goals/{goal_id}/follow", response_model=FollowView)
async def follow_goal(goal_id: UUID, db: Db, viewer: Viewer):
    return await _set_follow(goal_id, db, viewer.id, enabled=True)


@router.delete("/goals/{goal_id}/follow", response_model=FollowView)
async def unfollow_goal(goal_id: UUID, db: Db, viewer: Viewer):
    return await _set_follow(goal_id, db, viewer.id, enabled=False)


async def _set_like(checkin_id: UUID, db: AsyncSession, viewer_id: UUID, *, enabled: bool) -> LikeView:
    await _checkin(checkin_id, viewer_id, db, lock=True)
    if enabled:
        await db.execute(insert(HabitLike).values(
            checkin_id=checkin_id, user_id=viewer_id,
        ).on_conflict_do_nothing())
    else:
        await db.execute(delete(HabitLike).where(
            HabitLike.checkin_id == checkin_id, HabitLike.user_id == viewer_id,
        ))
    count = await db.scalar(select(func.count()).select_from(HabitLike).where(HabitLike.checkin_id == checkin_id))
    await db.commit()
    return LikeView(liked=enabled, like_count=count)


@router.put("/checkins/{checkin_id}/like", response_model=LikeView)
async def like_checkin(checkin_id: UUID, db: Db, viewer: Viewer):
    return await _set_like(checkin_id, db, viewer.id, enabled=True)


@router.delete("/checkins/{checkin_id}/like", response_model=LikeView)
async def unlike_checkin(checkin_id: UUID, db: Db, viewer: Viewer):
    return await _set_like(checkin_id, db, viewer.id, enabled=False)


@router.get("/checkins/{checkin_id}/comments", response_model=list[CommentView])
async def list_comments(checkin_id: UUID, db: Db, viewer: Viewer,
                        offset: Offset = 0, limit: Limit = 20):
    # 单条查询做可见性判定与分页；外人无法通过评论端点探测私密记录。
    visible = (select(HabitCheckin.id, HabitGoal.owner_id)
               .join(HabitGoal, HabitGoal.id == HabitCheckin.goal_id)
               .join(User, User.id == HabitGoal.owner_id)
               .where(HabitCheckin.id == checkin_id, _readable_checkin(viewer.id)).cte())
    comments = (select(HabitComment, User).join(User, User.id == HabitComment.author_id)
                .where(HabitComment.checkin_id == checkin_id, _visible_user())
                .order_by(HabitComment.created_at, HabitComment.id).offset(offset).limit(limit).subquery())
    from sqlalchemy.orm import aliased
    comment = aliased(HabitComment, comments)
    author = aliased(User, comments)
    rows = (await db.execute(select(visible.c.owner_id, comment, author)
                             .outerjoin(comments, comment.checkin_id == visible.c.id)
                             .order_by(comment.created_at, comment.id))).all()
    if not rows:
        raise HTTPException(404, "打卡不存在")
    return [_comment_view(comment, author, owner_id, viewer.id)
            for owner_id, comment, author in rows if comment is not None]


@router.post("/checkins/{checkin_id}/comments", response_model=CommentView, status_code=201)
async def create_comment(checkin_id: UUID, payload: CommentCreate, db: Db, viewer: Viewer):
    _, goal = await _checkin(checkin_id, viewer.id, db, lock=True)
    comment = HabitComment(checkin_id=checkin_id, author_id=viewer.id, content=_clean(payload.content))
    db.add(comment)
    await db.commit()
    return _comment_view(comment, viewer, goal.owner_id, viewer.id)


@router.delete("/checkins/{checkin_id}/comments/{comment_id}", status_code=204)
async def delete_comment(checkin_id: UUID, comment_id: UUID, db: Db, viewer: Viewer):
    _, goal = await _checkin(checkin_id, viewer.id, db, lock=True)
    stmt = delete(HabitComment).where(HabitComment.id == comment_id, HabitComment.checkin_id == checkin_id)
    if goal.owner_id != viewer.id:
        stmt = stmt.where(HabitComment.author_id == viewer.id)
    deleted = await db.scalar(stmt.returning(HabitComment.id))
    if deleted is None:
        raise HTTPException(404, "评论不存在或不可删除")
    await db.commit()
    return Response(status_code=204)


@router.get("/leaderboard", response_model=list[RankView])
async def leaderboard(db: Db, viewer: Viewer, offset: Offset = 0, limit: Limit = 50):
    today = _today()
    streak = HabitGoal.public_streak
    best = (select(HabitGoal.id.label("goal_id"), streak.label("days"), func.row_number().over(
        partition_by=HabitGoal.owner_id, order_by=(streak.desc(), HabitGoal.created_at, HabitGoal.id),
    ).label("choice"))
            .join(User, User.id == HabitGoal.owner_id)
            .where(_public_goal(), HabitGoal.public_last_date.in_((today, today - timedelta(days=1))), streak > 0)
            .subquery())
    ranked = (select(best.c.goal_id, func.rank().over(order_by=best.c.days.desc()).label("rank"))
              .where(best.c.choice == 1).subquery())
    rows = (await db.execute(select(ranked.c.rank, HabitGoal, User, _following(viewer.id))
                             .join(HabitGoal, HabitGoal.id == ranked.c.goal_id)
                             .join(User, User.id == HabitGoal.owner_id)
                             .order_by(ranked.c.rank, HabitGoal.owner_id).offset(offset).limit(limit))).all()
    return [RankView(rank=rank, goal=_goal_view(goal, owner, follows, today, public=True))
            for rank, goal, owner, follows in rows]
