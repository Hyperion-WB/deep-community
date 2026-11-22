"""账号注销 / 缓冲期 / 彻底清除 的统一实现。

规则（与产品约定一致）：
- 用户自助注销、管理员删除用户，都只是「进入缓冲期」（status='deleting'），
  用户名、邮箱、内容一律保留，因此用户名/邮箱在整个缓冲期内仍被占用，
  其他人注册时会命中唯一约束，提示"已被占用"。
- 缓冲期内该用户对他人不可见：帖子 published/scheduled → hidden，
  评论 visible → hidden，个人主页直接 404。
- 缓冲期结束（purge_after <= now）由定时任务调用 purge_user_data() 彻底清除，
  这段级联删除逻辑与管理员"立即彻底删除"共用同一份实现。
- 超级管理员可以随时 restore_user() 一键还原：状态、内容可见性、绑定关系
  全部恢复，不丢失任何数据。
"""

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, or_, select, update, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.timezone import utc_now
from app.models.chat import (
    Conversation,
    GroupJoinRequest,
    GroupMember,
    GroupMessage,
    GroupRoom,
    Message,
)
from app.models.comment import Comment
from app.models.feedback import Feedback, FeedbackUpvote
from app.models.poll import Poll, PollOption, PollVote
from app.models.post import (
    Collection,
    Like,
    Post,
    PostEdit,
    PostImage,
    PostSeries,
    SeriesItem,
)
from app.models.system import AdminAuditLog, Notification, Report
from app.models.user import Checkin, Follow, InviteCode, User, UserBlock

logger = logging.getLogger(__name__)

# 进入缓冲期时的状态常量
STATUS_DELETING = "deleting"
# 缓冲期内帖子被隐藏的原状态（恢复时统一还原为 published）
HIDDEN_POST_STATUSES = ("published", "scheduled")


async def request_user_deletion(db: AsyncSession, user: User) -> datetime:
    """把账号置入 10 天缓冲期（软删除）。不修改任何身份信息。"""
    now = utc_now()
    days = max(1, int(settings.DELETION_GRACE_DAYS or 10))
    purge_after = now + timedelta(days=days)

    # 记住原状态，便于恢复时回到原位（probation / active 等）
    if user.status != STATUS_DELETING:
        user.status_before_deletion = user.status
    user.status = STATUS_DELETING
    user.deletion_requested_at = now
    user.purge_after = purge_after
    # 立刻踢下线：所有旧 access / refresh token 失效
    user.token_version = (user.token_version or 0) + 1

    # 内容整体隐藏（列表查询都按 status 过滤，hidden 不会再出现在任何信息流）
    await db.execute(
        update(Post)
        .where(Post.author_id == user.id, Post.status.in_(HIDDEN_POST_STATUSES))
        .values(status="hidden")
    )
    # 先把这些评论对帖子的冗余计数扣回去，再隐藏；否则帖子评论数会虚高到次日对账
    await db.execute(text(
        "UPDATE posts p SET comment_count = GREATEST(COALESCE(p.comment_count,0) - x.cnt, 0) "
        "FROM (SELECT post_id, count(*) AS cnt FROM comments "
        "      WHERE author_id = :uid AND status = 'visible' GROUP BY post_id) x "
        "WHERE p.id = x.post_id"
    ), {"uid": str(user.id)})
    await db.execute(
        update(Comment)
        .where(Comment.author_id == user.id, Comment.status == "visible")
        .values(status="hidden")
    )
    await db.commit()
    logger.warning(f"[Deletion] 账号 @{user.username} 进入注销缓冲期，预计 {purge_after.isoformat()} 彻底清除")
    return purge_after


async def restore_user(db: AsyncSession, user: User) -> None:
    """超级管理员一键恢复：状态、内容可见性、缓冲期标记全部还原。"""
    restored_status = user.status_before_deletion or "active"
    user.status = restored_status
    user.status_before_deletion = None
    user.deletion_requested_at = None
    user.purge_after = None
    # 强制重新登录，避免旧会话被"复活"
    user.token_version = (user.token_version or 0) + 1

    await db.execute(
        update(Post)
        .where(Post.author_id == user.id, Post.status == "hidden")
        .values(status="published")
    )
    await db.execute(
        update(Comment)
        .where(Comment.author_id == user.id, Comment.status == "hidden")
        .values(status="visible")
    )
    await db.commit()
    logger.warning(f"[Deletion] 账号 @{user.username} 已被恢复（status={restored_status}）")


async def purge_user_data(db: AsyncSession, target: User) -> str:
    """彻底清空该用户全量数据并删除账号（不可逆）。返回用户名快照。

    调用方负责权限校验与审计记录；这里只做数据层工作。
    """
    username_backup = target.username
    try:
        # 1. 互动与行为关联数据
        await db.execute(delete(PollVote).where(PollVote.user_id == target.id))
        await db.execute(delete(Like).where(Like.user_id == target.id))
        await db.execute(delete(Collection).where(Collection.user_id == target.id))
        await db.execute(delete(Follow).where(or_(Follow.follower_id == target.id, Follow.following_id == target.id)))
        await db.execute(delete(UserBlock).where(or_(UserBlock.blocker_id == target.id, UserBlock.blocked_id == target.id)))
        await db.execute(delete(Checkin).where(Checkin.user_id == target.id))
        await db.execute(delete(Notification).where(or_(Notification.receiver_id == target.id, Notification.sender_id == target.id)))
        await db.execute(delete(Report).where(Report.reporter_id == target.id))
        await db.execute(update(Report).where(Report.resolved_by == target.id).values(resolved_by=None))
        await db.execute(delete(FeedbackUpvote).where(FeedbackUpvote.user_id == target.id))
        await db.execute(delete(Feedback).where(Feedback.user_id == target.id))
        await db.execute(update(Feedback).where(Feedback.admin_replied_by == target.id).values(admin_replied_by=None))
        # 审计日志原则上保留（谁在何时做了什么），仅把操作者置空；旧库该列非空时降级为删除
        try:
            async with db.begin_nested():
                await db.execute(update(AdminAuditLog).where(AdminAuditLog.admin_id == target.id).values(admin_id=None))
        except Exception:
            await db.execute(delete(AdminAuditLog).where(AdminAuditLog.admin_id == target.id))

        # 2. 私聊与群组
        conv_ids = (await db.execute(
            select(Conversation.id).where(or_(Conversation.user_small_id == target.id, Conversation.user_big_id == target.id))
        )).scalars().all()
        if conv_ids:
            await db.execute(delete(Message).where(Message.conversation_id.in_(conv_ids)))
            await db.execute(delete(Conversation).where(Conversation.id.in_(conv_ids)))
        await db.execute(delete(Message).where(Message.sender_id == target.id))

        await db.execute(delete(GroupMessage).where(GroupMessage.sender_id == target.id))
        await db.execute(delete(GroupMember).where(GroupMember.user_id == target.id))
        await db.execute(delete(GroupJoinRequest).where(or_(GroupJoinRequest.user_id == target.id, GroupJoinRequest.handled_by == target.id)))

        # 群主注销：移交最早加入的成员；无人则解散空群
        owned_rooms = (await db.execute(select(GroupRoom).where(GroupRoom.creator_id == target.id))).scalars().all()
        for owned_room in owned_rooms:
            heir = (await db.execute(
                select(GroupMember)
                .where(GroupMember.room_id == owned_room.id)
                .order_by(GroupMember.joined_at.asc())
                .limit(1)
            )).scalar_one_or_none()
            if heir:
                heir.role = "owner"
                owned_room.creator_id = heir.user_id
            else:
                await db.delete(owned_room)

        # 3. 专栏与文集
        user_series = (await db.execute(select(PostSeries.id).where(PostSeries.author_id == target.id))).scalars().all()
        if user_series:
            await db.execute(delete(SeriesItem).where(SeriesItem.series_id.in_(user_series)))
            await db.execute(delete(PostSeries).where(PostSeries.id.in_(user_series)))

        # 4. 帖子及其深层关联
        user_posts = (await db.execute(select(Post.id).where(Post.author_id == target.id))).scalars().all()
        if user_posts:
            await db.execute(delete(SeriesItem).where(SeriesItem.post_id.in_(user_posts)))
            await db.execute(delete(PostEdit).where(PostEdit.post_id.in_(user_posts)))
            await db.execute(delete(PostImage).where(PostImage.post_id.in_(user_posts)))

            post_polls = (await db.execute(select(Poll.id).where(Poll.post_id.in_(user_posts)))).scalars().all()
            if post_polls:
                await db.execute(delete(PollVote).where(PollVote.poll_id.in_(post_polls)))
                await db.execute(delete(PollOption).where(PollOption.poll_id.in_(post_polls)))
                await db.execute(delete(Poll).where(Poll.id.in_(post_polls)))

            post_comments = (await db.execute(select(Comment.id).where(Comment.post_id.in_(user_posts)))).scalars().all()
            if post_comments:
                await db.execute(update(Comment).where(Comment.id.in_(post_comments)).values(parent_id=None))
                await db.execute(delete(Like).where(Like.target_type == "comment", Like.target_id.in_(post_comments)))
                await db.execute(delete(Comment).where(Comment.id.in_(post_comments)))

            await db.execute(delete(Like).where(Like.target_type == "post", Like.target_id.in_(user_posts)))
            await db.execute(delete(Collection).where(Collection.post_id.in_(user_posts)))
            await db.execute(delete(Post).where(Post.id.in_(user_posts)))

        # 5. 该用户在其他帖子下的评论
        await db.execute(update(Comment).where(Comment.reply_to_user_id == target.id).values(reply_to_user_id=None))
        user_comments = (await db.execute(select(Comment.id).where(Comment.author_id == target.id))).scalars().all()
        if user_comments:
            await db.execute(update(Comment).where(Comment.parent_id.in_(user_comments)).values(parent_id=None))
            await db.execute(delete(Like).where(Like.target_type == "comment", Like.target_id.in_(user_comments)))
            await db.execute(delete(Comment).where(Comment.id.in_(user_comments)))

        # 6. 邀请码
        await db.execute(update(InviteCode).where(InviteCode.used_by_id == target.id).values(used_by_id=None, is_used=False))
        await db.execute(delete(InviteCode).where(InviteCode.generator_id == target.id))

        # 7. 删除用户主体
        await db.delete(target)
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    # 8. 清理缓存
    try:
        from app.core.database import get_redis
        redis = get_redis()
        if redis:
            await redis.delete(f"community:user:{target.id}")
            today_str = datetime.now(timezone.utc).strftime("%Y%m%d")
            await redis.delete(f"community:anon_quota:{target.id}:{today_str}")
    except Exception:
        pass

    logger.warning(f"[Deletion] 账号 @{username_backup} ({target.id}) 已彻底清除")
    return username_backup


async def purge_expired_deletions(max_batch: int = 200) -> int:
    """定时任务入口：清除所有已过缓冲期的账号，返回清理数量。"""
    from app.core.database import AsyncSessionLocal

    removed = 0
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            select(User)
            .where(User.status == STATUS_DELETING, User.purge_after.is_not(None), User.purge_after <= utc_now())
            .limit(max_batch)
        )).scalars().all()

        for user in rows:
            if user.role in ("super_admin", "admin"):
                # 安全兜底：管理员账号即使误入缓冲期也不自动清除
                logger.error(f"[Deletion] 检测到管理员账号 @{user.username} 处于待清除状态，已跳过")
                continue
            try:
                await purge_user_data(db, user)
                removed += 1
            except Exception as exc:
                logger.error(f"[Deletion] 清除账号 @{user.username} 失败: {exc}", exc_info=True)
                await db.rollback()
    return removed
