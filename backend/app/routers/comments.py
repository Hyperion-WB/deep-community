from uuid import UUID
from typing import List, Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request

def ensure_utc(dt: Optional[datetime]) -> datetime:
    if dt is None:
        return datetime.now(timezone.utc)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func, update, or_, and_, exists
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload, aliased
from app.core.database import get_db, get_redis
from app.models.comment import Comment
from app.models.post import Post, Like
from app.models.user import User
from app.models.system import Notification
from app.schemas.comment import CommentCreateRequest, CommentResponse
from app.core.cache import get_cached_json, set_cached_json
from app.routers.deps import get_current_user, get_current_user_optional, is_admin_role
from app.services.anon_service import check_and_consume_anon_quota, generate_anonymous_alias
from app.services.sensitive_service import sensitive_filter
from app.services.level_service import add_user_experience, record_user_activity
from app.core.cache import invalidate_posts_cache

router = APIRouter(prefix="/comments", tags=["评论互动"])

@router.post("", response_model=CommentResponse)
async def create_comment(
    req: CommentCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    # 检查帖子是否存在及评论策略
    post_q = select(Post).where(Post.id == req.post_id)
    post = (await db.execute(post_q)).scalar_one_or_none()
    if not post or post.status == "deleted":
        raise HTTPException(status_code=404, detail="关联帖子不存在")

    # 草稿/定时/下架文章不允许被评论（作者与管理员除外）
    if post.status != "published" and user.id != post.author_id and not is_admin_role(user.role):
        raise HTTPException(status_code=404, detail="关联帖子不存在")

    if post.comment_policy == "closed":
        raise HTTPException(status_code=403, detail="该帖子作者已关闭评论区")
    elif post.comment_policy == "member_only" and user.status == "probation":
        raise HTTPException(status_code=403, detail="该帖子仅允许正式会员发表评论")

    # 单条评论最多一张图（普通图片或自定义表情），只接受本站上传路径，防止外链注入
    image_url = (req.image_url or "").strip()
    image_kind = (req.image_kind or "").strip()
    if image_url:
        if not image_url.startswith("/uploads/"):
            raise HTTPException(status_code=400, detail="图片地址不合法，请重新上传")
        if image_kind not in ("photo", "sticker"):
            image_kind = "photo"
    else:
        image_kind = ""

    if not (req.content or "").strip() and not image_url:
        raise HTTPException(status_code=400, detail="评论内容不能为空")

    # 敏感词扫描
    is_blocked, hit_words, cleaned_content = sensitive_filter.scan(req.content)
    if is_blocked:
        raise HTTPException(status_code=400, detail=f"评论包含违规敏感词: {', '.join(hit_words)}")

    # 回复目标校验先于配额扣除：避免"校验失败但匿名配额已被永久扣掉"
    depth = 0
    if req.parent_id:
        parent_check = (await db.execute(select(Comment).where(Comment.id == req.parent_id))).scalar_one_or_none()
        if not parent_check:
            raise HTTPException(status_code=404, detail="回复的目标评论不存在")
        # 父评论必须属于同一篇文章，否则评论树会跨文章串味
        if parent_check.post_id != req.post_id:
            raise HTTPException(status_code=400, detail="回复的目标评论不属于该文章")
        if parent_check.status == "deleted":
            # 主楼删除但楼中楼还在时，不应把跟评锁死：允许继续回复、点赞、删除。
            # 只有「主楼已删且没有任何可见跟评」才真正关闭这条讨论。
            alive_children = (await db.execute(
                select(func.count(Comment.id)).where(
                    Comment.parent_id == req.parent_id,
                    Comment.status == "visible",
                )
            )).scalar() or 0
            if alive_children == 0:
                raise HTTPException(status_code=400, detail="该评论已被删除，无法在此回复")

        # 楼中楼深度上限：沿父链回溯计数，防止无限深嵌套链
        cursor = parent_check
        while cursor is not None and depth <= 10:
            depth += 1
            if cursor.parent_id is None:
                break
            cursor = (await db.execute(select(Comment).where(Comment.id == cursor.parent_id))).scalar_one_or_none()
        if depth > 10:
            raise HTTPException(status_code=400, detail="回复嵌套层数已达上限，请直接回复根评论")

        # reply_to_user_id 必须确实参与过该帖讨论，避免借回复功能给任意用户推送通知
        if req.reply_to_user_id and req.reply_to_user_id not in (parent_check.author_id, post.author_id):
            involved = (await db.execute(
                select(Comment.id).where(
                    Comment.post_id == req.post_id,
                    Comment.author_id == req.reply_to_user_id,
                    Comment.status == "visible"
                ).limit(1)
            )).first()
            if not involved:
                raise HTTPException(status_code=400, detail="被回复的用户未参与该文章的讨论")

    alias = None
    if req.is_anonymous:
        redis = get_redis()
        if not redis:
            raise HTTPException(status_code=500, detail="缓存组件异常")
        try:
            # 原子检查并扣除匿名配额（校验全部通过后才扣，失败不消耗次数）
            await check_and_consume_anon_quota(user.id, user.level, redis)
        except ValueError as e:
            raise HTTPException(status_code=403, detail=str(e))

        is_author = (user.id == post.author_id)
        alias = generate_anonymous_alias(post.id, user.id, is_author)

    # 问答广场：提问者不能自问自答；单用户单问题只能留下 1 个根回答
    if req.parent_id is None:
        from app.services.qa_service import qa_can_answer
        await qa_can_answer(db, post.id, user)

    # 图片配额放在所有校验之后扣除：校验失败（敏感词/父评论/匿名额度）不再白扣当天额度
    if image_url:
        from app.services.image_quota import ImageQuotaExceeded, consume_image_quota

        try:
            await consume_image_quota(user, "comment")
        except ImageQuotaExceeded as exc:
            raise HTTPException(status_code=429, detail=str(exc))

    new_comment = Comment(
        post_id=req.post_id,
        author_id=user.id,
        parent_id=req.parent_id,
        reply_to_user_id=req.reply_to_user_id,
        content=cleaned_content,
        image_url=image_url,
        image_kind=image_kind,
        is_anonymous=req.is_anonymous,
        anonymous_alias=alias
    )
    db.add(new_comment)
    # 必须先把新评论刷进会话拿到主键：Column(default=uuid.uuid4) 是 Python 侧默认值，
    # 未 flush 时 new_comment.id 仍是 None，导致所有 comment/reply/mention 通知的
    # comment_id 落成 NULL，通知中心点击后无法定位到具体评论。
    await db.flush()
    # 登记问答回答（唯一约束防并发重复；楼中楼回复不算回答）
    if req.parent_id is None:
        from app.services.qa_service import register_answer
        await register_answer(db, post.id, user.id, new_comment.id)
    # 原子自增，避免并发评论丢计数
    await db.execute(
        update(Post).where(Post.id == post.id).values(comment_count=Post.comment_count + 1)
    )

    # 消息通知闭环: 评论文章通知作者，楼中楼回复通知父评者。
    # 通知 db.add 必须先于经验/活跃（它们内部会 commit），确保同事务一并落库
    sender_name = alias if req.is_anonymous else (user.nickname or user.username)
    # 本轮需要实时提醒的接收者（文章作者 / 被回复者 / 被 @ 者）
    notified_users: set = set()
    if not req.parent_id:
        if post.author_id != user.id:
            notif = Notification(
                receiver_id=post.author_id,
                sender_id=None if req.is_anonymous else user.id,
                action_type="comment",
                target_id=post.id,
                comment_id=new_comment.id,
                brief=f"{sender_name} 评论了你的文章《{post.title[:20]}》"
            )
            db.add(notif)
            notified_users.add(post.author_id)
    else:
        # 优先通知被 @ 的特定回复对象
        if req.reply_to_user_id and req.reply_to_user_id != user.id:
            notif = Notification(
                receiver_id=req.reply_to_user_id,
                sender_id=None if req.is_anonymous else user.id,
                action_type="reply",
                target_id=post.id,
                comment_id=new_comment.id,
                brief=f"{sender_name} 回复了你在《{post.title[:20]}》下的评论"
            )
            db.add(notif)
            notified_users.add(req.reply_to_user_id)

        # 若主楼评论作者不是自己且尚未通知，通知主楼作者
        # comment_id 指向新回复本身（此前错指父评论，导致点击通知定位到旧评论）
        if parent_check and parent_check.author_id != user.id and parent_check.author_id not in notified_users:
            notif = Notification(
                receiver_id=parent_check.author_id,
                sender_id=None if req.is_anonymous else user.id,
                action_type="reply",
                target_id=post.id,
                comment_id=new_comment.id,
                brief=f"{sender_name} 回复了你在《{post.title[:20]}》下的评论"
            )
            db.add(notif)

    # ---------- @ 提及通知 ----------
    # 规则：匿名评论不产生提及（否则等于用匿名身份戳人，也容易反推身份）；
    #      同一评论重复 @ 只发一次；@ 到不存在的用户名按普通文本处理，不发通知。
    if not req.is_anonymous:
        import re as _re

        mentioned = {
            name for name in _re.findall(r"@([A-Za-z0-9_\u4e00-\u9fa5]{2,32})", cleaned_content or "")
        }
        if mentioned:
            skip_ids = {post.author_id, user.id}
            if req.reply_to_user_id:
                skip_ids.add(req.reply_to_user_id)
            # 回复评论时，前端会自动在正文里带上「@对方」。
            # 如果被回复的人（主楼作者 / 指定回复对象）已经收到「回复」通知，
            # 这里就不能再发一条「@提及」通知，否则同一次回复会弹两条。
            if req.parent_id and parent_check is not None:
                skip_ids.add(parent_check.author_id)
            # 前端的 @ 现在展示「可修改的昵称」，因此昵称也要能匹配到用户；
            # 先按唯一用户名匹配，剩下的再按昵称兜底，避免同名昵称误伤。
            rows_by_username = (
                await db.execute(select(User).where(User.username.in_(mentioned)))
            ).scalars().all()
            remaining = mentioned - {u.username for u in rows_by_username}
            rows_by_nickname = []
            if remaining:
                rows_by_nickname = (
                    await db.execute(select(User).where(User.nickname.in_(remaining)))
                ).scalars().all()
            rows = list(rows_by_username) + list(rows_by_nickname)
            seen_ids = set()
            for target_user in rows:
                # notified_users 兜底：已经因「回复」收到通知的人不再收 @ 通知，
                # 避免同一次回复弹两条（主动 @ 其他人不受影响）
                if target_user.id in skip_ids or target_user.id in seen_ids or target_user.id in notified_users:
                    continue
                seen_ids.add(target_user.id)
                db.add(
                    Notification(
                        receiver_id=target_user.id,
                        sender_id=user.id,
                        action_type="mention",
                        target_id=post.id,
                        comment_id=new_comment.id,
                        brief=f"{sender_name} 在《{post.title[:20]}》的评论中提到了你",
                    )
                )
                notified_users.add(target_user.id)

    # 经验与活跃（内部 commit 放最后，保证上面所有变更一并提交）
    if len(cleaned_content) >= 5 and not req.is_anonymous:
        await add_user_experience(user, 2, db)
    await record_user_activity(user, db)

    await db.commit()
    await invalidate_posts_cache()

    # 实时通知：在线用户立刻亮红点，不用等 20 秒轮询
    if notified_users:
        from app.services.notify_push import push_notification_hints
        await push_notification_hints(notified_users, "comment", "有新的评论或提及")

    # ---------- 彩蛋：评论区「求好运」/ 与同一人互回超过二十层 ----------
    if not req.is_anonymous:
        try:
            from app.services.achievement_engine import unlock_egg
            if "求好运" in (cleaned_content or ""):
                await unlock_egg(db, user, "egg_lucky_koi")
            if new_comment.parent_id:
                from sqlalchemy import text as _sql
                pair_rows = (await db.execute(_sql(
                    "SELECT c2.author_id, count(*) AS cnt FROM comments c1 "
                    "JOIN comments c2 ON c1.parent_id = c2.id "
                    "WHERE c1.post_id = :pid AND c1.author_id = :uid AND c2.author_id <> :uid "
                    "GROUP BY c2.author_id ORDER BY cnt DESC LIMIT 1"
                ), {"pid": str(new_comment.post_id), "uid": str(user.id)})).all()
                if pair_rows and int(pair_rows[0][1]) >= 20:
                    await unlock_egg(db, user, "egg_buddy")
        except Exception:
            pass

    return CommentResponse(
        id=new_comment.id,
        post_id=new_comment.post_id,
        parent_id=new_comment.parent_id,
        content=new_comment.content,
        image_url=new_comment.image_url or "",
        image_kind=new_comment.image_kind or "",
        is_anonymous=new_comment.is_anonymous,
        anonymous_alias=new_comment.anonymous_alias,
        is_featured=new_comment.is_featured,
        like_count=0,
        is_liked=False,
        created_at=ensure_utc(new_comment.created_at),
        author_username=None if req.is_anonymous else user.username,
        author_nickname=None if req.is_anonymous else user.nickname,
        author_avatar=None if req.is_anonymous else user.avatar_url,
        author_level=None if req.is_anonymous else user.level,
        replies=[]
    )


@router.get("/post/{post_id}", response_model=List[CommentResponse])
async def get_post_comments(
    post_id: UUID,
    request: Request,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db)
):
    """评论列表（主楼分页 + 完整楼中楼子树）。

    此前一次性全量加载全部评论（含 selectinload 作者），万级评论帖响应体与内存无上限。
    现按主楼分页：每页返回 size 条主评论及其全部子回复；
    通过响应头 X-Comments-Has-More / X-Comments-Total 告知前端是否还有下一页。
    """

    # 首屏评论 10 秒短缓存：评论列表要递归拉取所有子回复，是热门帖最重的一次查询。
    # 只缓存第一页，且按访问者区分（is_liked 是用户态）。
    cache_key = f"cache:comments:{post_id}:{page}:{size}:{user.id if user else 'anon'}"
    if page == 1:
        cached_comments = await get_cached_json(cache_key)
        if cached_comments:
            try:
                request.state.comments_has_more = "1" if cached_comments.get("has_more") else "0"
                request.state.comments_total = int(cached_comments.get("total") or 0)
                return [CommentResponse(**x) for x in cached_comments.get("items", [])]
            except Exception:
                pass
    # 先校验文章可见性：草稿/定时/已删除文章的评论不得对外暴露
    target_post = (await db.execute(select(Post).where(Post.id == post_id))).scalar_one_or_none()
    if not target_post or target_post.status == "deleted":
        raise HTTPException(status_code=404, detail="帖子不存在")
    if target_post.status != "published":
        is_author = bool(user and user.id == target_post.author_id)
        is_admin = bool(user and is_admin_role(user.role))
        if not (is_author or is_admin):
            raise HTTPException(status_code=404, detail="帖子不存在")

    base_filter = [Comment.post_id == post_id, Comment.status.in_(["visible", "deleted"])]

    # 主楼可见性：未删除，或虽已删除但仍有可见子回复（墓碑要保留楼中楼）。
    # 统计与分页必须用同一条件，否则「已删且无子回复」的主楼会被算进 total，
    # 造成 X-Comments-Total 虚高、翻到最后一页出现空页。
    _child = aliased(Comment)
    active_root = or_(
        Comment.status == "visible",
        exists().where(
            and_(_child.parent_id == Comment.id, _child.status == "visible")
        ),
    )
    root_filter = [Comment.post_id == post_id, Comment.parent_id.is_(None), active_root]

    # 主楼分页（精选优先 → 时间正序，offset/limit 稳定分页）
    total_roots = (await db.execute(
        select(func.count(Comment.id)).where(*root_filter)
    )).scalar() or 0

    roots_res = await db.execute(
        select(Comment).options(selectinload(Comment.author)).where(
            *root_filter
        ).order_by(Comment.is_featured.desc(), Comment.created_at.asc())
        .offset((page - 1) * size).limit(size)
    )
    roots = roots_res.scalars().all()

    # 逐层拉取这些主楼的全部后代（楼中楼深度上限 10 层），保证子树完整
    all_comments = list(roots)
    current_ids = [c.id for c in roots]
    for _ in range(10):
        if not current_ids:
            break
        children_res = await db.execute(
            select(Comment)
            .options(selectinload(Comment.author))
            .where(
                Comment.post_id == post_id,
                Comment.status.in_(["visible", "deleted"]),
                Comment.parent_id.in_(current_ids)
            )
            # 必须显式排序：PostgreSQL 不保证无 ORDER BY 的结果顺序，
            # 且行被更新过（点赞/采纳/编辑）后会写到新位置，
            # 表现就是"同一条回复有时候在最上面、有时候跑到下面"
            .order_by(Comment.created_at.asc(), Comment.id.asc())
        )
        children = children_res.scalars().all()
        if not children:
            break
        all_comments.extend(children)
        current_ids = [c.id for c in children]

    liked_comment_ids = set()
    if user and all_comments:
        c_ids = [c.id for c in all_comments if c.status == "visible"]
        if c_ids:
            like_q = select(Like.target_id).where(Like.user_id == user.id, Like.target_type == "comment", Like.target_id.in_(c_ids))
            liked_comment_ids = set((await db.execute(like_q)).scalars().all())

    # 构建楼中楼树形 (支持多层回复平铺到所属主楼，确保绝不漏掉任何评论)
    comment_map = {}
    raw_map = {c.id: c for c in all_comments}
    raw_top_level = []

    for c in all_comments:
        is_del = (c.status == "deleted")
        c_dict = CommentResponse(
            id=c.id,
            post_id=c.post_id,
            parent_id=c.parent_id,
            content="该评论已被删除" if is_del else c.content,
            image_url="" if is_del else (c.image_url or ""),
            image_kind="" if is_del else (c.image_kind or ""),
            is_anonymous=False if is_del else c.is_anonymous,
            anonymous_alias=None if is_del else c.anonymous_alias,
            is_featured=False if is_del else c.is_featured,
            is_accepted=False if is_del else bool(getattr(c, 'is_accepted', False)),
            like_count=0 if is_del else c.like_count,
            is_liked=(c.id in liked_comment_ids) if not is_del else False,
            is_deleted=is_del,
            created_at=ensure_utc(c.created_at),
            author_username=None if (is_del or c.is_anonymous) else (c.author.username if c.author else "注销用户"),
            author_nickname="已删除" if is_del else (None if c.is_anonymous else (c.author.nickname if c.author else None)),
            author_avatar=None if (is_del or c.is_anonymous) else (c.author.avatar_url if c.author else ""),
            author_level=None if (is_del or c.is_anonymous) else (c.author.level if c.author else 0),
            replies=[]
        )
        comment_map[c.id] = c_dict

    # 递归/追溯主楼顶级评论 ID
    def get_root_parent_id(c_id):
        curr = raw_map.get(c_id)
        visited = set()
        while curr and curr.parent_id and curr.parent_id in raw_map:
            if curr.parent_id in visited:
                break
            visited.add(curr.id)
            curr = raw_map.get(curr.parent_id)
        return curr.id if curr else c_id

    for c in all_comments:
        if c.parent_id and c.parent_id in raw_map:
            root_id = get_root_parent_id(c.id)
            if root_id != c.id and root_id in comment_map:
                comment_map[root_id].replies.append(comment_map[c.id])
            else:
                raw_top_level.append(comment_map[c.id])
        else:
            raw_top_level.append(comment_map[c.id])

    # 过滤掉孤立的、没有可见子回复的已删除评论
    final_top_level = []
    for c_item in raw_top_level:
        # 子回复中被删除的直接过滤
        c_item.replies = [r for r in c_item.replies if not r.is_deleted]
        # 如果顶级评论已被删除，且其下没有任何有效子回复，则彻底隐藏不展示
        if c_item.is_deleted and len(c_item.replies) == 0:
            continue
        # 首屏只带前 2 条子回复：热门帖一个主楼可能挂几十条回复，
        # 全量返回会把首屏响应体撑大；其余由「展开全部」按需拉取。
        total_replies = len(c_item.replies)
        c_item.reply_total = total_replies
        if total_replies > 2:
            c_item.replies = c_item.replies[:2]
        final_top_level.append(c_item)

    # 分页信息经响应头传递（保持数组响应体兼容）
    has_more = page * size < total_roots
    request.state.comments_has_more = "1" if has_more else "0"
    request.state.comments_total = total_roots

    if page == 1:
        try:
            await set_cached_json(
                cache_key,
                {
                    "has_more": has_more,
                    "total": total_roots,
                    "items": [c.model_dump(mode="json") for c in final_top_level],
                },
                ttl=10,
            )
        except Exception:
            pass

    return final_top_level

@router.get("/{comment_id}/replies", response_model=List[CommentResponse])
async def get_comment_replies(
    comment_id: UUID,
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """按需拉取某个主楼下的全部子回复。

    评论列表首屏只带前 2 条，用户点「展开全部 N 条回复」时再走这里，
    避免热门帖首屏一次拖回上百条回复。
    """
    root = (await db.execute(select(Comment).where(Comment.id == comment_id))).scalar_one_or_none()
    if not root:
        raise HTTPException(status_code=404, detail="评论不存在")

    post = (await db.execute(select(Post).where(Post.id == root.post_id))).scalar_one_or_none()
    if not post or post.status == "deleted":
        raise HTTPException(status_code=404, detail="帖子不存在")
    if post.status != "published":
        is_author = bool(user and user.id == post.author_id)
        is_admin = bool(user and is_admin_role(user.role))
        if not (is_author or is_admin):
            raise HTTPException(status_code=404, detail="帖子不存在")

    all_children: list[Comment] = []
    current_ids = [root.id]
    for _ in range(10):
        if not current_ids:
            break
        rows = (await db.execute(
            select(Comment)
            .options(selectinload(Comment.author))
            .where(
                Comment.post_id == root.post_id,
                Comment.status == "visible",
                Comment.parent_id.in_(current_ids),
            )
            .order_by(Comment.created_at.asc(), Comment.id.asc())
            .limit(300)
        )).scalars().all()
        if not rows:
            break
        all_children.extend(rows)
        current_ids = [c.id for c in rows]

    liked_ids = set()
    if user and all_children:
        like_q = select(Like.target_id).where(
            Like.user_id == user.id,
            Like.target_type == "comment",
            Like.target_id.in_([c.id for c in all_children]),
        )
        liked_ids = set((await db.execute(like_q)).scalars().all())

    return [
        CommentResponse(
            id=c.id,
            post_id=c.post_id,
            parent_id=c.parent_id,
            content=c.content,
            image_url=c.image_url or "",
            image_kind=c.image_kind or "",
            is_anonymous=c.is_anonymous,
            anonymous_alias=c.anonymous_alias,
            is_featured=c.is_featured,
            is_accepted=bool(getattr(c, "is_accepted", False)),
            like_count=c.like_count,
            is_liked=c.id in liked_ids,
            is_deleted=False,
            created_at=ensure_utc(c.created_at),
            author_username=None if c.is_anonymous else (c.author.username if c.author else "注销用户"),
            author_nickname=None if c.is_anonymous else (c.author.nickname if c.author else None),
            author_avatar=None if c.is_anonymous else (c.author.avatar_url if c.author else ""),
            author_level=None if c.is_anonymous else (c.author.level if c.author else 0),
            replies=[],
        )
        for c in all_children
    ]


@router.post("/{comment_id}/like")
async def toggle_like_comment(
    comment_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """评论点赞 / 取消点赞（切换式）。

    - 行锁串行化同一条评论的并发点击，避免双击产生重复计数或 500
    - 返回 commit 后重新查到的真实计数，不再返回 ORM 里的过期值
    - 同一用户对同一条评论只发一次点赞通知，反复取消/重赞不刷屏
    """
    c_q = select(Comment).where(Comment.id == comment_id).with_for_update()
    comment = (await db.execute(c_q)).scalar_one_or_none()
    if not comment or comment.status != "visible":
        raise HTTPException(status_code=404, detail="评论不存在")

    like_q = select(Like).where(
        Like.user_id == user.id,
        Like.target_type == "comment",
        Like.target_id == comment_id,
    )
    existing_like = (await db.execute(like_q)).scalar_one_or_none()

    if existing_like:
        await db.delete(existing_like)
        await db.execute(
            update(Comment).where(Comment.id == comment_id).values(
                like_count=func.greatest(Comment.like_count - 1, 0)
            )
        )
        is_liked = False
    else:
        db.add(Like(user_id=user.id, target_type="comment", target_id=comment_id))
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            fresh = await db.scalar(select(Comment.like_count).where(Comment.id == comment_id))
            return {"is_liked": True, "like_count": int(fresh or 0)}
        await db.execute(
            update(Comment).where(Comment.id == comment_id).values(like_count=Comment.like_count + 1)
        )
        is_liked = True

        if comment.author_id != user.id:
            dup = (await db.execute(
                select(func.count(Notification.id)).where(
                    Notification.receiver_id == comment.author_id,
                    Notification.sender_id == user.id,
                    Notification.action_type == "like_comment",
                    Notification.comment_id == comment.id,
                )
            )).scalar() or 0
            if dup == 0:
                post_title = (await db.execute(
                    select(Post.title).where(Post.id == comment.post_id)
                )).scalar_one_or_none() or ""
                db.add(Notification(
                    receiver_id=comment.author_id,
                    sender_id=user.id,
                    action_type="like_comment",
                    target_id=comment.post_id,
                    comment_id=comment.id,
                    brief=f"@{user.nickname or user.username} 赞了你在《{post_title[:20]}》下的评论",
                ))

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        fresh = await db.scalar(select(Comment.like_count).where(Comment.id == comment_id))
        return {"is_liked": True, "like_count": int(fresh or 0)}

    # commit 后重新查一次，避免返回 ORM 对象的旧值
    fresh_count = await db.scalar(
        select(Comment.like_count).where(Comment.id == comment_id)
    )
    return {"is_liked": is_liked, "like_count": int(fresh_count or 0)}


@router.delete("/{comment_id}")
async def delete_comment(
    comment_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    c_q = select(Comment).where(Comment.id == comment_id)
    comment = (await db.execute(c_q)).scalar_one_or_none()
    if not comment or comment.status == "deleted":
        raise HTTPException(status_code=404, detail="评论不存在")

    # 允许作者本人、超级管理员、管理员、版主进行合规下架
    if comment.author_id != user.id and user.role not in ["super_admin", "admin", "moderator"]:
        raise HTTPException(status_code=403, detail="无权删除该评论")

    comment.status = "deleted"

    # 回答被删除/违规下架：扣回该回答已发放的问答采纳奖励
    from app.services.qa_service import clawback_answer
    await clawback_answer(db, comment.id)

    # 同步扣减关联文章的评论统计
    post_q = select(Post).where(Post.id == comment.post_id)
    post = (await db.execute(post_q)).scalar_one_or_none()
    if post:
        # 原子自减：此前是 ORM 读-改-写，两条评论并发删除会各自读到同一个旧值，
        # 最终只减了 1；创建侧本来就是 SQL 原子自增，这里保持一致。
        await db.execute(
            update(Post).where(Post.id == post.id).values(
                comment_count=func.greatest(Post.comment_count - 1, 0)
            )
        )
        # 被删除的评论若正是"已采纳答案"，必须清空采纳标记，否则文章会指向一条墓碑评论
        if getattr(post, "accepted_comment_id", None) == comment.id:
            post.accepted_comment_id = None

    await db.commit()
    await invalidate_posts_cache()
    return {"success": True, "message": "评论已删除"}

@router.put("/{comment_id}/featured")
async def toggle_feature_comment(
    comment_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """帖子作者或管理员精选置顶评论"""
    c_q = select(Comment).options(selectinload(Comment.post)).where(Comment.id == comment_id)
    comment = (await db.execute(c_q)).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="评论未找到")

    if comment.status != "visible":
        raise HTTPException(status_code=400, detail="该评论已删除，无法设为精选")

    if comment.post.author_id != user.id and user.role not in ["super_admin", "admin", "moderator"]:
        raise HTTPException(status_code=403, detail="只有该帖作者或管理员可精选置顶")

    comment.is_featured = not comment.is_featured
    await db.commit()
    return {"is_featured": comment.is_featured}

@router.put("/{comment_id}/accept")
async def toggle_accept_solution(
    comment_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """问答区采纳最佳解答 (仅帖主或管理员可操作)"""
    c_q = select(Comment).options(selectinload(Comment.post)).where(Comment.id == comment_id)
    # 问答广场的问题必须走 /qa/posts/{id}/settle（多人平分悬赏 + 流水），
    # 这里保留旧帖的单选采纳能力，避免破坏已有交互
    from app.services.qa_service import qa_state
    if await qa_state(db, (await db.execute(
        select(Comment.post_id).where(Comment.id == comment_id)
    )).scalar_one_or_none(), user):
        raise HTTPException(status_code=400, detail="问答广场请使用「批量采纳并结算悬赏」")
    comment = (await db.execute(c_q)).scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="评论未找到")

    post = comment.post
    if not post:
        raise HTTPException(status_code=404, detail="关联帖子未找到")

    if post.author_id != user.id and user.role not in ["super_admin", "admin", "moderator"]:
        raise HTTPException(status_code=403, detail="仅帖子作者或管理员可采纳最佳解答")

    if comment.status != "visible":
        raise HTTPException(status_code=400, detail="该评论已删除或不可见")

    if getattr(comment, 'is_accepted', False):
        comment.is_accepted = False
        post.accepted_comment_id = None
        action = "unaccepted"
    else:
        # 取消本帖下其他所有已采纳评论
        other_comments = (await db.execute(select(Comment).where(Comment.post_id == post.id, Comment.is_accepted == True))).scalars().all()
        for oc in other_comments:
            oc.is_accepted = False
        comment.is_accepted = True
        post.accepted_comment_id = comment.id
        action = "accepted"

        # 发送通知给被采纳者
        if comment.author_id and comment.author_id != user.id:
            notif = Notification(
                receiver_id=comment.author_id,
                sender_id=user.id,
                action_type="accepted_solution",
                target_id=post.id,
                comment_id=comment.id,
                brief=f"您的回答在《{post.title[:30]}》中被采纳为最佳解答！"
            )
            db.add(notif)

    await db.commit()
    return {"is_accepted": comment.is_accepted, "action": action, "comment_id": comment.id}

