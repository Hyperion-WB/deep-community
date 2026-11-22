"""幂等初始化脚本。

生产部署默认**只确保管理员与分类存在**，不会创建测试账号或演示文章。
如确实需要演示数据（开发/验收环境），设置 SEED_DEMO_DATA=1 再运行。
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from app.core.config import settings
from app.core.database import AsyncSessionLocal, engine, Base
from app.core.security import get_password_hash, verify_password
from app.models.user import User
from app.models.post import Category, Post
from app.models.comment import Comment
from app.models.poll import Poll, PollOption
import app.models


def _demo_enabled() -> bool:
    return (os.getenv("SEED_DEMO_DATA", "0") or "").strip().lower() in ("1", "true", "yes", "on")


async def seed():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSessionLocal() as db:
        # 1. 管理员：使用 BOOTSTRAP_ADMIN_PASSWORD，且强制首次登录改密
        bootstrap_password = settings.BOOTSTRAP_ADMIN_PASSWORD.strip()
        res = await db.execute(select(User).where(User.username == "admin"))
        admin = res.scalar_one_or_none()
        if not admin:
            admin = User(
                username="admin",
                email="admin@community.local",
                password_hash=get_password_hash(bootstrap_password),
                role="super_admin",
                nickname="最高系统管理员",
                status="active",
                register_channel="invite",
                level=6,
                experience=9999,
                bio="社区最高系统管理员。",
                must_change_password=True,
            )
            db.add(admin)
            await db.flush()
            print("[Seed] 已创建超级管理员 admin（首次登录必须修改密码）")
        elif not getattr(admin, "must_change_password", False) and verify_password(
            bootstrap_password, admin.password_hash
        ):
            admin.must_change_password = True
            print("[Seed] 检测到管理员仍在使用初始口令，已标记为必须改密")

        # 2. 分类（与主程序启动逻辑一致，幂等补齐）
        categories_data = [
            ("科技前沿", "tech", "探讨尖端算力、AI 智能体与未来系统", 1),
            ("新闻早报", "news", "社区官方每日早报与全球要闻速递", 2),
            ("极客日常", "geek", "极客生活、桌面搭配与软硬件折腾", 3),
            ("开发者社区", "dev", "架构设计、算法工程与技术讨论", 4),
            ("综合交流", "general", "随笔杂谈、自由交流与生活点滴", 5),
        ]
        cat_map = {}
        for name, slug, desc, order in categories_data:
            c_res = await db.execute(select(Category).where(Category.slug == slug))
            cat = c_res.scalar_one_or_none()
            if not cat:
                cat = Category(name=name, slug=slug, description=desc, sort_order=order)
                db.add(cat)
                await db.flush()
            cat_map[slug] = cat
        print("[Seed] 分类初始化完毕")

        # 3. 演示数据仅在显式开启时创建，避免污染生产库
        if not _demo_enabled():
            await db.commit()
            print("[Seed] 生产模式：跳过测试账号与演示文章（如需请设 SEED_DEMO_DATA=1）")
            return

        res = await db.execute(select(User).where(User.username == "matrix"))
        matrix_user = res.scalar_one_or_none()
        if not matrix_user:
            matrix_user = User(
                username="matrix",
                email="matrix@community.local",
                password_hash=get_password_hash("user123456"),
                role="user",
                status="active",
                register_channel="invite",
                level=3,
                experience=680,
                bio="全栈极客，热爱钛灰极简美学与高并发架构。",
            )
            db.add(matrix_user)
            await db.flush()
            print("[Seed] 已创建演示会员 matrix")

        p_res = await db.execute(select(Post))
        if not p_res.scalars().first():
            post_news = Post(
                author_id=admin.id,
                category_id=cat_map["news"].id,
                title="【早报】社区 4.0 钛金属黑白极简版本正式上线发布",
                content_md="社区 4.0 版本现已完成全面升级，欢迎在下方畅所欲言！",
                content_html="<p>社区 4.0 版本现已完成全面升级...</p>",
                post_type="news",
                status="published",
                is_pinned=True,
                view_count=189,
                like_count=32,
                comment_count=2,
            )
            db.add(post_news)
            await db.flush()

            c1 = Comment(
                post_id=post_news.id,
                author_id=matrix_user.id,
                content="界面过渡比之前流畅太多了，黑白钛金属质感很有深度！",
                is_anonymous=False,
                like_count=5,
                status="visible",
            )
            c2 = Comment(
                post_id=post_news.id,
                author_id=admin.id,
                content="匿名测试：今日匿名配额生效中，支持前台隐匿真实身份发声。",
                is_anonymous=True,
                anonymous_alias="神秘雪豹#27",
                like_count=3,
                status="visible",
            )
            db.add_all([c1, c2])

            post_poll = Post(
                author_id=matrix_user.id,
                category_id=cat_map["tech"].id,
                title="探讨：在现代 UI 中，你更倾向于哪种设计流派？",
                content_md="在黑白高对比度、工业钛灰胶囊风与传统扁平拟物之间，大家的审美偏向是怎样的？欢迎投票交流！",
                content_html="<p>随着大模型和高刷屏幕的普及，Web 应用的视觉风格正在经历剧烈迭代...</p>",
                post_type="post",
                status="published",
                is_pinned=False,
                view_count=76,
                like_count=18,
                comment_count=1,
            )
            db.add(post_poll)
            await db.flush()

            poll = Poll(
                post_id=post_poll.id,
                title="你最欣赏的前端设计风格：",
                is_multiple=False,
                max_choices=1,
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
            db.add(poll)
            await db.flush()

            db.add_all([
                PollOption(poll_id=poll.id, option_text="黑白极简与物理弹性动效 (当前风格)", vote_count=24),
                PollOption(poll_id=poll.id, option_text="拟态磨砂玻璃 (Glassmorphism)", vote_count=7),
                PollOption(poll_id=poll.id, option_text="传统高色彩扁平风", vote_count=3),
            ])

            c3 = Comment(
                post_id=post_poll.id,
                author_id=matrix_user.id,
                content="毫不犹豫投了黑白极简！阅读长文本和代码时极其舒适，不会分心。",
                is_anonymous=False,
                like_count=2,
                status="visible",
            )
            db.add(c3)
            print("[Seed] 演示文章与投票创建完成")

        await db.commit()
        print("[Seed] 种子数据全部提交成功！")


if __name__ == "__main__":
    asyncio.run(seed())
