import os
import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select, update, delete, cast, or_, String
from app.core.database import AsyncSessionLocal, get_redis
from app.models.post import Post, PostImage
from app.models.system import Notification
from app.core.config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('wb.scheduler')

# 明确北京时间：容器 TZ 常为 UTC，不指定时区会让「凌晨 04:00」落在北京时间中午
JOB_TZ = 'Asia/Shanghai'

scheduler = AsyncIOScheduler(timezone=JOB_TZ)


async def acquire_job_lock(name: str, ttl_seconds: int = 55) -> bool:
    """跨 worker 的任务互斥锁。

    APScheduler 是进程内调度，多 worker / 多副本会各跑一遍定时任务（重复发布、重复清理），
    因此每个任务执行前先抢一把 Redis 锁；未配置 Redis 时退化为单进程语义。
    """
    redis = get_redis()
    if not redis:
        return True
    try:
        ok = await redis.set(f"wb:scheduler:{name}", uuid.uuid4().hex, ex=ttl_seconds, nx=True)
        return bool(ok)
    except Exception:
        # fail-closed：锁服务异常时宁可跳过本周期，也不能让多 worker 同时
        # 发布 / 物理删图 / 全表对账，否则后果不可逆
        logging.exception("[Scheduler] 任务锁获取失败，跳过本次执行: %s", name)
        return False



async def clean_orphan_images():
    """清理 24 小时未被任何内容引用的真正孤儿临时图片（保护磁盘，杜绝误删 404）。

    引用来源必须覆盖全站：文章正文/封面/相册、用户头像、私聊与群聊消息、
    评论配图、反馈截图、群头像、举报截图、专栏封面、全站/群公告正文。
    漏掉任何一类，那一类图片就会在 24 小时后被物理删除。
    """
    if not await acquire_job_lock("clean_orphan_images", ttl_seconds=600):
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    async with AsyncSessionLocal() as db:
        query = select(PostImage).where(
            PostImage.status == "temp",
            PostImage.created_at < cutoff
        )
        res = await db.execute(query)
        orphan_images = res.scalars().all()

        from app.models.user import User

        for img in orphan_images:
            if not img.storage_path:
                await db.delete(img)
                continue

            # 安全校验：二次查验该图片是否在任何文章正文、封面或用户头像中实际被使用
            lookup_paths = [img.storage_path]
            if img.storage_path.startswith("http://") or img.storage_path.startswith("https://"):
                idx = img.storage_path.find("/uploads/")
                if idx != -1:
                    lookup_paths.append(img.storage_path[idx:])

            in_post = None
            for p in lookup_paths:
                found = (await db.execute(
                    select(Post.id).where(Post.content_md.contains(p, escape='\\')).limit(1)
                )).scalar_one_or_none()
                if found:
                    in_post = found
                    break

            if not in_post:
                for p in lookup_paths:
                    in_cover = (await db.execute(
                        select(Post.id).where(Post.cover_image == p).limit(1)
                    )).scalar_one_or_none()
                    if in_cover:
                        in_post = in_cover
                        break

            # 九宫格相册：图片不在正文里，必须单独按 image_urls 判断，
            # 否则除第一张（同时作为封面）外的相册图会被当成孤儿物理删除。
            if not in_post:
                for p in lookup_paths:
                    in_gallery = (await db.execute(
                        select(Post.id).where(
                            Post.image_urls.isnot(None),
                            cast(Post.image_urls, String).contains(p, escape='\\'),
                        ).limit(1)
                    )).scalar_one_or_none()
                    if in_gallery:
                        in_post = in_gallery
                        break

            in_avatar = None
            for p in lookup_paths:
                found_avatar = (await db.execute(
                    select(User.id).where(User.avatar_url == p).limit(1)
                )).scalar_one_or_none()
                if found_avatar:
                    in_avatar = found_avatar
                    break

            # 聊天 / 评论 / 反馈 / 群头像等同样通过 /posts/upload-image 上传，
            # 同样会留下 status=temp 的记录；此前只校验「文章 + 用户头像」，
            # 于是群里发的图、评论配图、反馈截图、群头像都会在 24 小时后被当成孤儿物理删除
            # —— 表现就是「图片发出去当天能看，第二天/第三天就裂了」。
            in_other = False
            if not in_post and not in_avatar:
                from app.models.chat import GroupAnnouncement, GroupMessage, GroupRoom, Message
                from app.models.comment import Comment
                from app.models.feedback import Feedback
                from app.models.post import PostSeries
                from app.models.system import Report, SiteAnnouncement

                async def _exists(stmt) -> bool:
                    return (await db.execute(stmt.limit(1))).scalar_one_or_none() is not None

                for p in lookup_paths:
                    # 群聊 / 私聊消息正文
                    if await _exists(select(GroupMessage.id).where(GroupMessage.content.contains(p, escape='\\'))):
                        in_other = True
                        break
                    if await _exists(select(Message.id).where(Message.content.contains(p, escape='\\'))):
                        in_other = True
                        break
                    # 评论：正文内联图 + 单独配图字段
                    if await _exists(select(Comment.id).where(or_(
                        Comment.content.contains(p, escape='\\'),
                        Comment.image_url == p,
                    ))):
                        in_other = True
                        break
                    # 反馈：单图兼容字段 + 多图 JSON
                    if await _exists(select(Feedback.id).where(or_(
                        Feedback.image_url == p,
                        cast(Feedback.image_urls, String).contains(p, escape='\\'),
                    ))):
                        in_other = True
                        break
                    # 群头像
                    if await _exists(select(GroupRoom.id).where(GroupRoom.avatar_url == p)):
                        in_other = True
                        break
                    # 举报截图
                    if await _exists(select(Report.id).where(Report.image_url == p)):
                        in_other = True
                        break
                    # 专栏封面
                    if await _exists(select(PostSeries.id).where(PostSeries.cover_image == p)):
                        in_other = True
                        break
                    # 全站公告 / 群公告正文里的内嵌图
                    if await _exists(select(SiteAnnouncement.id).where(SiteAnnouncement.content.contains(p, escape='\\'))):
                        in_other = True
                        break
                    if await _exists(select(GroupAnnouncement.id).where(GroupAnnouncement.content.contains(p, escape='\\'))):
                        in_other = True
                        break

            # 如果检测到确实被引用，纠正状态为 attached，免于物理删除，彻底解决 404
            if in_post or in_avatar or in_other:
                img.status = "attached"
                if in_post:
                    img.post_id = in_post
                continue

            # 表情包是永久资源（用户资产），即使暂时没被引用也不能删
            if "/uploads/stickers/" in (img.storage_path or ""):
                img.status = "attached"
                continue

            # 物理删除确实无人引用的孤儿文件：本地文件与对象存储对象两边一起删
            from app.services.image_service import delete_stored_image
            await asyncio.to_thread(delete_stored_image, img.storage_path)
            await db.delete(img)

        await db.commit()

async def publish_scheduled_posts():
    """扫描并上线已到点的定时文章。

    - 多 worker 下通过 Redis 锁保证只执行一次；
    - 普通文章保留原始创建时间（避免"定时发布 = 顶帖"）；
    - 每日早报（post_type=news）沿用刷新发布时间的行为，保证首页时效；
    - **上线前必须复审敏感词**：草稿保存不扫描，若这里直接 UPDATE，
      违规内容会完全绕过审核直接公开。命中则退回草稿，交人工处理。
    """
    if not await acquire_job_lock("publish_scheduled_posts", ttl_seconds=50):
        return

    from app.services.sensitive_service import sensitive_filter
    from app.utils.sanitizer import clean_html

    now = datetime.now(timezone.utc)
    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(Post).where(
                    Post.status == "scheduled",
                    Post.scheduled_at <= now,
                ).with_for_update(skip_locked=True)
            )
        ).scalars().all()
        if not rows:
            return

        for post in rows:
            blocked_t, _hits_t, clean_title = sensitive_filter.scan(post.title or "")
            blocked_c, _hits_c, clean_content = sensitive_filter.scan(post.content_md or "")
            if blocked_t or blocked_c:
                # 含有违规词：不静默上线，退回草稿让人工处理
                post.status = "draft"
                post.scheduled_at = None
                # 必须告知作者，否则只会以为「定时发布没生效」
                db.add(Notification(
                    receiver_id=post.author_id,
                    sender_id=None,
                    action_type="system",
                    target_id=post.id,
                    brief=f"《{(post.title or '')[:20]}》定时发布未通过内容审核，已退回草稿，请修改后重新发布",
                ))
                # 登记到待审队列，供超级管理员在后台复核（判断是否误伤）
                from sqlalchemy import text as _sql_text
                hits = ",".join([str(h) for h in ((_hits_t or []) + (_hits_c or []))])[:500]
                await db.execute(_sql_text(
                    "INSERT INTO sensitive_review_queue (post_id, author_id, title, hits) "
                    "VALUES (:pid, :aid, :title, :hits)"
                ), {"pid": str(post.id), "aid": str(post.author_id),
                    "title": (post.title or "")[:200], "hits": hits})
                continue

            post.title = clean_title
            if clean_content != (post.content_md or ""):
                post.content_md = clean_content
                post.content_html = clean_html(clean_content)

            post.status = "published"
            if post.first_published_at is None:
                post.first_published_at = now
            if post.post_type == "news":
                if post.album_quota_at is None and isinstance(post.image_urls, list) and len(post.image_urls) >= 2:
                    post.album_quota_at = post.created_at
                post.created_at = now

        await db.commit()

        # 定时上线的帖子同样立即触发 AI 评论
        from app.services.ai_service import schedule_ai_comment
        for post in rows:
            if post.status == "published" and post.post_type != "news":
                schedule_ai_comment(str(post.id))

async def reload_sensitive_words():
    """从数据库加载动态敏感词库并重建过滤 Trie。

    此前 SensitiveWord 表的数据从未被载入，运营入库的词完全不生效；
    现于启动时加载一次，并每 10 分钟热重载，词库变更无需重启服务。
    """
    from app.models.system import SensitiveWord
    from app.services.sensitive_service import sensitive_filter
    async with AsyncSessionLocal() as db:
        res = await db.execute(select(SensitiveWord.word, SensitiveWord.action))
        rows = res.all()
    sensitive_filter.load_words_from_list([(w, a) for w, a in rows])
    print(f"[Sensitive] 动态敏感词库已加载 {len(rows)} 条 (内置保底词仍生效)")


async def reconcile_counts():
    """每日计数对账：以关联表真实行数校准冗余计数列，根治历史并发漂移。

    对账范围：帖子点赞/评论/收藏数、评论点赞数、反馈 UP 数、投票票数。
    """
    from sqlalchemy import text
    async with AsyncSessionLocal() as db:
        # 只修正不一致的行：无条件 UPDATE 会用旧快照覆盖对账期间的新写入
        await db.execute(text(
            "UPDATE posts p SET like_count = x.lc, comment_count = x.cc, collect_count = x.kc "
            "FROM (SELECT p2.id,"
            "  (SELECT count(*) FROM likes l WHERE l.target_type='post' AND l.target_id=p2.id) lc,"
            "  (SELECT count(*) FROM comments c WHERE c.post_id=p2.id AND c.status='visible') cc,"
            "  (SELECT count(*) FROM collections k WHERE k.post_id=p2.id) kc "
            "  FROM posts p2) x WHERE x.id=p.id AND ("
            "  p.like_count IS DISTINCT FROM x.lc OR p.comment_count IS DISTINCT FROM x.cc"
            "  OR p.collect_count IS DISTINCT FROM x.kc)"
        ))
        await db.execute(text(
            "UPDATE comments c SET like_count = x.n FROM ("
            "  SELECT c2.id, (SELECT count(*) FROM likes l WHERE l.target_type='comment' AND l.target_id=c2.id) n"
            "  FROM comments c2) x WHERE x.id=c.id AND c.like_count IS DISTINCT FROM x.n"
        ))
        await db.execute(text(
            "UPDATE feedbacks f SET upvotes_count = x.n FROM ("
            "  SELECT f2.id, (SELECT count(*) FROM feedback_upvotes u WHERE u.feedback_id=f2.id) n"
            "  FROM feedbacks f2) x WHERE x.id=f.id AND f.upvotes_count IS DISTINCT FROM x.n"
        ))
        await db.execute(text(
            "UPDATE poll_options o SET vote_count = x.n FROM ("
            "  SELECT o2.id, (SELECT count(*) FROM poll_votes v WHERE v.option_id=o2.id) n"
            "  FROM poll_options o2) x WHERE x.id=o.id AND o.vote_count IS DISTINCT FROM x.n"
        ))
        await db.commit()
    logger.info("[Reconcile] 计数对账完成 (posts/comments/feedbacks/polls)")


async def purge_expired_invite_codes():
    """永久删除已过期的邀请码（包括已核销的记录）。"""
    if not await acquire_job_lock("purge_invite_codes", ttl_seconds=55):
        return

    from app.models.user import InviteCode

    async with AsyncSessionLocal() as db:
        result = await db.execute(delete(InviteCode).where(InviteCode.expires_at <= datetime.now(timezone.utc)))
        await db.commit()
    if result.rowcount:
        logger.info("[InviteCode] 已清理 %s 条过期邀请码", result.rowcount)


async def purge_expired_sessions():
    """回收过期登录会话与其 Redis 凭证。

    refresh 凭证按 sid 存储且不设 TTL（避免被缓存淘汰策略误删），
    因此必须由定时任务按 user_sessions.created_at 统一清理，防止无限增长。
    """
    if not await acquire_job_lock("purge_sessions", ttl_seconds=600):
        return

    from app.models.user import UserSession

    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    redis = get_redis()
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(
            # 按 last_active_at 清理：否则长期活跃但会话行 created_at 较旧的账号，
            # 会在 refresh 仍有效时被删行，配合旧逻辑造成「已下线设备复活」
            select(UserSession).where(UserSession.last_active_at < cutoff)
        )).scalars().all()
        for session in rows:
            try:
                if redis:
                    await redis.delete(f"rt:sid:{session.id}")
            except Exception:
                pass
            await db.delete(session)
        if rows:
            await db.commit()
            print(f"[Session] 已清理过期登录会话 {len(rows)} 条")


async def settle_leaderboard_titles():
    """每天结算榜单限时称号：上榜者获得称号，掉榜自动失效并卸下。"""
    from zoneinfo import ZoneInfo
    from sqlalchemy import text
    from app.routers.stats import get_leaderboards, BOARD_TITLE_MAP

    tz = ZoneInfo("Asia/Shanghai")
    now = datetime.now(timezone.utc).astimezone(tz)
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    expires = tomorrow.astimezone(timezone.utc)

    async with AsyncSessionLocal() as db:
        try:
            data = await get_leaderboards(db)
        except Exception:
            logger.exception("[Scheduler] 榜单称号结算：读取榜单失败")
            return

        awards = []
        for board_key in ("total", "early", "active"):
            for row in data.get(board_key, []):
                rank, uname = row.get("rank"), row.get("username")
                if not uname: continue
                for title, (b, r) in BOARD_TITLE_MAP.items():
                    if b == board_key and r == rank:
                        awards.append((uname, title))

        await db.execute(text("DELETE FROM user_titles WHERE expires_at <= now()"))
        for uname, title in awards:
            await db.execute(text(
                "INSERT INTO user_titles (user_id, title, source, expires_at) "
                "SELECT id, :title, 'leaderboard', :exp FROM users WHERE username = :uname "
                "ON CONFLICT (user_id, title, source) DO UPDATE SET expires_at = :exp"
            ), {"title": title, "exp": expires, "uname": uname})

        await db.execute(text(
            "UPDATE users SET equipped_title = NULL WHERE equipped_title IS NOT NULL "
            "AND equipped_title IN (SELECT title FROM user_titles) "
            "AND NOT EXISTS (SELECT 1 FROM user_titles t WHERE t.user_id = users.id "
            "                AND t.title = users.equipped_title AND t.expires_at > now())"
        ))
        await db.commit()
        logger.info("[Scheduler] 限时称号结算完成，发放 %d 个", len(awards))


def start_scheduler():
    async def _reload_safe():
        try:
            await reload_sensitive_words()
        except Exception as e:
            print(f"[Sensitive] 敏感词库热重载失败: {e}")

    async def _clean_safe():
        try:
            await clean_orphan_images()
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "孤儿图片清理")

    async def _publish_safe():
        try:
            await publish_scheduled_posts()
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "定时发布")

    async def _ops_flush_safe():
        try:
            from app.services.ops_service import flush_metrics
            await flush_metrics()
        except Exception as e:
            print(f"[Ops] 运维指标落库失败: {e}")

    async def _ops_purge_safe():
        try:
            from app.services.ops_service import purge_old_visits
            removed = await purge_old_visits()
            if removed:
                print(f"[Ops] 已清理过期访问明细 {removed} 条")
        except Exception as e:
            print(f"[Ops] 访问明细清理失败: {e}")

    async def _reconcile_safe():
        if not await acquire_job_lock("reconcile_counts", ttl_seconds=600):
            return
        try:
            await reconcile_counts()
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "计数对账")

    async def _purge_deletions_safe():
        """清除超过 10 天缓冲期的注销账号（彻底不可逆）。"""
        if not await acquire_job_lock("purge_expired_deletions", ttl_seconds=1800):
            return
        try:
            from app.services.user_deletion import purge_expired_deletions
            removed = await purge_expired_deletions()
            if removed:
                print(f"[Deletion] 已彻底清除 {removed} 个到期注销账号")
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "注销账号清理")

    async def _purge_sessions_safe():
        try:
            await purge_expired_sessions()
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "过期会话清理")

    async def _storage_mirror_safe():
        """对象存储镜像补传：把本地已落盘、但还没同步到 R2 的文件补上。

        上传时已经有一次"立即尝试"，这里是兜底 —— 覆盖进程重启、
        对象存储短暂不可用、以及上传瞬间网络抖动的情况。
        """
        try:
            from app.services.storage_sync import process_pending

            stats = await process_pending()
            if stats.get("ok") or stats.get("failed"):
                print(
                    f"[Storage] 镜像补传 成功={stats['ok']} 失败={stats['failed']} "
                    f"积压={stats['pending']}"
                )
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "存储镜像补传")

    async def _refresh_link_icons_safe():
        """友情链接图标补抓：添加时抓失败（对方临时 502 等）的每天重试一次"""
        try:
            from app.routers.friend_links import refresh_missing_icons

            fixed = await refresh_missing_icons()
            if fixed:
                print(f"[FriendLink] 已补抓 {fixed} 个友链图标")
        except Exception as e:
            logger.exception("[Scheduler] %s 执行失败", "友链图标补抓")

    # 启动时立即加载一次动态敏感词库；多 worker 下管理端写入只会刷新处理请求的那个进程，
    # 因此每 1 分钟兜底重载一次，保证新词在 1 分钟内全进程生效。
    scheduler.add_job(_reload_safe, 'interval', minutes=1, id='sensitive_reload',
                      next_run_time=datetime.now(timezone.utc))
    # 每天凌晨 04:00 执行垃圾图片清理
    scheduler.add_job(_clean_safe, 'cron', hour=4, minute=0, id='clean_orphan_images', timezone=JOB_TZ)
    # 每天凌晨 04:30 执行计数对账（以关联表真实行数校准冗余计数列）
    scheduler.add_job(_reconcile_safe, 'cron', hour=4, minute=30, id='reconcile_counts', timezone=JOB_TZ)
    # 每分钟检查一次定时发布
    scheduler.add_job(_publish_safe, 'interval', minutes=1, id='publish_scheduled_posts')
    # 每 30 秒把内存中的 API 计数刷入当日汇总表（运维面板数据来源）
    scheduler.add_job(_ops_flush_safe, 'interval', seconds=30, max_instances=1, id='ops_flush')
    # 每天 04:10 清理超过保留期的访问明细（默认 60 天）
    scheduler.add_job(_ops_purge_safe, 'cron', hour=4, minute=10, max_instances=1, id='ops_purge', timezone=JOB_TZ)
    # 每天 04:20 回收过期登录会话（refresh 凭证无 TTL，需主动清理）
    scheduler.add_job(_purge_sessions_safe, 'cron', hour=4, minute=20, id='purge_sessions', timezone=JOB_TZ)
    scheduler.add_job(purge_expired_invite_codes, 'interval', minutes=1, id='purge_invite_codes',
                      next_run_time=datetime.now(timezone.utc))
    # 每小时扫描一次到期的注销账号（缓冲期 10 天，小时级精度足够）
    scheduler.add_job(_purge_deletions_safe, 'interval', hours=1, max_instances=1, id='purge_expired_deletions')
    # 每天 03:40 给缺图标的友链补抓一次
    scheduler.add_job(_refresh_link_icons_safe, 'cron', hour=3, minute=40, max_instances=1, id='friend_link_icons', timezone=JOB_TZ)
    # 每 2 分钟补传一次对象存储镜像（本地始终是权威副本，补传慢一点没关系）
    # 对象存储停用期间不注册补传任务，避免每 2 分钟空跑一轮、刷无意义日志
    if settings.S3_ENABLED:
        scheduler.add_job(_storage_mirror_safe, 'interval', minutes=2, max_instances=1, id='storage_mirror')
    async def _settle_titles_safe():
        try:
            await settle_leaderboard_titles()
        except Exception:
            logger.exception("[Scheduler] 限时称号结算失败")

    scheduler.add_job(_settle_titles_safe, 'cron', hour=0, minute=5, id='settle_titles', timezone=JOB_TZ)
    async def _settle_game_season_safe():
        """归档上一赛季。每天尝试，保证月初服务停机后可以补结。"""
        if not await acquire_job_lock('settle_game_season', ttl_seconds=600):
            return
        try:
            from app.routers.minigames import settle_game_season
            from app.core.database import AsyncSessionLocal
            async with AsyncSessionLocal() as db:
                result = await settle_game_season(db)
                if not result.get('already_settled'):
                    logger.info("[Scheduler] 游戏赛季结算完成: %s", result.get('season'))
        except Exception:
            logger.exception("[Scheduler] 游戏赛季结算失败")

    scheduler.add_job(_settle_game_season_safe, 'cron', hour=0, minute=5,
                      id='settle_game_season', timezone=JOB_TZ)

    async def _ai_auto_comment_safe():
        """AI 自动评论：随机挑一篇没评过的帖子评一条（需超管开启并配置 Key）。

        每 5 分钟一轮、每轮最多 1 条，串行 + 随机停顿：
        模型扛不住并发，宁可慢一点也不要刷屏或触发 429。
        """
        # 锁 TTL 略小于调度间隔（300s）：既保证下一轮能抢到，又不会被两个 worker 同时执行。
        # 注意不能用「跑完立即释放」——两个 worker 的触发时间差 1~2 秒，
        # 先跑完释放锁后，后一个 worker 会立刻补一条，出现同一轮双发。
        if not await acquire_job_lock('ai_auto_comment', ttl_seconds=270):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.ai_service import auto_comment_recent
            async with AsyncSessionLocal() as db:
                n = await auto_comment_recent(db, max_posts=1)
                if n:
                    logger.info("[Scheduler] AI 自动评论 %s 条", n)
        except Exception:
            logger.exception("[Scheduler] AI 自动评论失败")

    scheduler.add_job(_ai_auto_comment_safe, 'interval', minutes=5,
                      id='ai_auto_comment', timezone=JOB_TZ)

    async def _chain_auto_end_safe():
        """成语接龙限时结算：每 30 秒扫描一次到点未结束的局并播报前三名。"""
        if not await acquire_job_lock('chain_auto_end', ttl_seconds=25):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.routers.group_activities import auto_end_expired_chains
            async with AsyncSessionLocal() as db:
                n = await auto_end_expired_chains(db)
                if n:
                    logger.info("[Scheduler] 接龙到点结算 %s 局", n)
        except Exception:
            logger.exception("[Scheduler] 接龙自动结算失败")

    scheduler.add_job(_chain_auto_end_safe, 'interval', seconds=30,
                      id='chain_auto_end', timezone=JOB_TZ)

    async def _feihua_auto_end_safe():
        """飞花令限时结算：每 30 秒扫描到点未结束的局并播报前三名。"""
        if not await acquire_job_lock('feihua_auto_end', ttl_seconds=25):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.routers.group_activities import auto_end_expired_feihua
            async with AsyncSessionLocal() as db:
                n = await auto_end_expired_feihua(db)
                if n:
                    logger.info("[Scheduler] 飞花令到点结算 %s 局", n)
        except Exception:
            logger.exception("[Scheduler] 飞花令自动结算失败")

    scheduler.add_job(_feihua_auto_end_safe, 'interval', seconds=30,
                      id='feihua_auto_end', timezone=JOB_TZ)

    async def _draw_guess_auto_end_safe():
        if not await acquire_job_lock('draw_guess_auto_end', ttl_seconds=55):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.routers.draw_guess import auto_end_expired_boards, prune_board_history
            async with AsyncSessionLocal() as db:
                count = await auto_end_expired_boards(db)
                pruned = await prune_board_history(db)
                if count or pruned:
                    logger.info("[Scheduler] 画猜自动结束 %s 局，清理 %s 个历史画板", count, pruned)
        except Exception:
            logger.exception("[Scheduler] 画猜结算/历史清理失败")

    scheduler.add_job(_draw_guess_auto_end_safe, 'interval', seconds=30,
                      id='draw_guess_auto_end', max_instances=1, timezone=JOB_TZ)

    async def _ai_daily_digest_safe():
        """每天 20:00（北京时间）给所有超级管理员推送 AI 回复日报。"""
        if not await acquire_job_lock('ai_daily_digest', ttl_seconds=600):
            return
        try:
            from sqlalchemy import select

            from app.core.database import AsyncSessionLocal
            from app.models.system import Notification
            from app.models.user import User
            from app.services.ai_service import ai_daily_digest

            async with AsyncSessionLocal() as db:
                digest = await ai_daily_digest(db)
                brief = f"AI 今日回复了 {digest['count']} 条帖子"
                if digest.get("best"):
                    brief += f"｜今日金句：{digest['best']}"
                brief += f"（心情：{digest['mood'][:20]}）"
                admins = (await db.execute(
                    select(User.id).where(User.role == "super_admin", User.status != "banned")
                )).scalars().all()
                for uid in admins:
                    db.add(Notification(
                        receiver_id=uid, sender_id=None,
                        action_type="ai_daily_digest", brief=brief[:255],
                    ))
                await db.commit()
                logger.info("[Scheduler] AI 日报已推送 %s 位超管：%s 条", len(admins), digest['count'])
        except Exception:
            logger.exception("[Scheduler] AI 日报推送失败")

    scheduler.add_job(_ai_daily_digest_safe, 'cron', hour=20, minute=0,
                      id='ai_daily_digest', timezone=JOB_TZ)

    async def _expire_qa_safe():
        """每天 00:10（北京时间）：7 天采纳期到期未结算的问题自动过期并退回悬赏。"""
        if not await acquire_job_lock('expire_qa_questions', ttl_seconds=600):
            return
        try:
            from app.core.database import AsyncSessionLocal
            from app.services.qa_service import expire_qa_questions

            async with AsyncSessionLocal() as db:
                n = await expire_qa_questions(db)
                if n:
                    logger.info("[Scheduler] 问答广场过期 %s 个问题，悬赏已退回", n)
        except Exception:
            logger.exception("[Scheduler] 问答悬赏过期结算失败")

    scheduler.add_job(_expire_qa_safe, 'cron', hour=0, minute=10,
                      id='expire_qa_questions', timezone=JOB_TZ)

    scheduler.start()

def stop_scheduler():
    scheduler.shutdown(wait=False)
