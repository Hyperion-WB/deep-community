from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from sqlalchemy import select, text
from app.core.config import settings
from app.core.database import engine, Base, init_redis, close_redis, get_redis
from app.core.migrations import ensure_schema, run_migrations
from app.tasks.scheduler import start_scheduler, stop_scheduler

from app.routers import ai_admin, site_contents, group_activities, qa, battles, media, minigames, stats, auth, users, posts, comments, polls, chat, admin, feedback, reactions, rules, ops, achievements, search, sensitive_words_admin, friend_links, stickers, meta, food, doudizhu, doudizhu_points, draw_guess, habits

import app.models # 确保所有 ORM 模型类被加载注册
import secrets
import logging

_startup_log = logging.getLogger("app.startup")

# 安全兜底：JWT 密钥必须由环境提供，避免源码里的默认值被直接拿去部署。
if not settings.JWT_SECRET_KEY:
    if settings.ENVIRONMENT == "production":
        raise RuntimeError(
            "JWT_SECRET_KEY 未配置。请在 .env 中设置：JWT_SECRET_KEY=$(openssl rand -hex 32)"
        )
    settings.JWT_SECRET_KEY = secrets.token_urlsafe(48)
    _startup_log.warning("JWT_SECRET_KEY 未配置，已生成进程级临时密钥；重启后现有登录态会失效")

# 初始超管口令：未配置时随机生成（同一进程内保持不变，日志只打印一次）
_GENERATED_ADMIN_PASSWORD = "" if settings.BOOTSTRAP_ADMIN_PASSWORD else secrets.token_urlsafe(9)


def _bootstrap_admin_password() -> str:
    return (settings.BOOTSTRAP_ADMIN_PASSWORD or _GENERATED_ADMIN_PASSWORD).strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 确保本地上传附件目录就绪
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # 1. 启动时等待数据库连接与表结构就绪 (最多重试 30 次，兼容 PostgreSQL 初次启动过程)
    import asyncio
    retries = 30
    while retries > 0:
        try:
            # 步骤 1: 独立事务创建所有基础表结构
            # 用咨询锁串行化建表：双 worker / 多副本首次启动不会撞出 duplicate table
            await ensure_schema(engine, Base.metadata)

            # 步骤 2: 版本化增量迁移（schema_migrations 记录已应用版本，多实例启动用咨询锁串行）
            await run_migrations(engine)

            # 版本化迁移可能新增板块（如「问答广场」），启动后失效分类缓存，
            # 避免 /posts/categories 的 1 小时缓存让新分区在编辑器/首页看不到
            from app.core.cache import invalidate_categories_cache
            await invalidate_categories_cache()

            # 步骤 3: 自动注入超级管理员 admin 与基础核心分类
            from app.core.database import AsyncSessionLocal
            from app.models.user import User
            from app.models.post import Category, Post
            from app.core.security import get_password_hash
            from sqlalchemy import select

            async with AsyncSessionLocal() as session:
                # 多 worker 同时启动时串行化种子注入，避免并发建 admin 触发唯一约束
                await session.execute(text("SELECT pg_advisory_xact_lock(941023002);"))
                admin_res = await session.execute(select(User).where(User.username == "admin"))
                admin_user = admin_res.scalar_one_or_none()
                if not admin_user:
                    bootstrap_password = _bootstrap_admin_password()
                    admin_user = User(
                        username="admin",
                        nickname="最高系统管理员",
                        email="admin@community.local",
                        password_hash=get_password_hash(bootstrap_password),
                        must_change_password=True,
                        role="super_admin",
                        status="active",
                        register_channel="invite",
                        level=6,
                        experience=9999,
                        bio="社区最高系统管理员"
                    )
                    session.add(admin_user)
                    await session.flush()
                    print("[Database] 初始超级管理员 admin 已创建；初始口令见 BOOTSTRAP_ADMIN_PASSWORD，未配置时为随机口令（见上方日志），首次登录后强制改密")

                if admin_user and not getattr(admin_user, "must_change_password", False):
                    from app.core.security import verify_password
                    _bootstrap = _bootstrap_admin_password()
                    if verify_password(_bootstrap, admin_user.password_hash):
                        admin_user.must_change_password = True
                        print("[Security] 检测到超级管理员仍在使用初始口令，已标记为必须改密")

                cat_res = await session.execute(select(Category))
                categories = cat_res.scalars().all()
                if not categories:
                    tech_cat = Category(name="科技前沿", slug="tech", description="尖端算力、AI 与系统架构", sort_order=1)
                    news_cat = Category(name="新闻早报", slug="news", description="社区官方发布与技术快讯", sort_order=2)
                    backend_cat = Category(name="后端架构", slug="backend", description="微服务与高并发性能调优", sort_order=3)
                    design_cat = Category(name="设计美学", slug="design", description="黑白钛金属极简工业美学", sort_order=4)
                    geek_cat = Category(name="极客日常", slug="geek", description="硬件 Homelab 与极客工作流", sort_order=5)
                    general_cat = Category(name="综合交流", slug="general", description="极客茶水间与闲聊讨论", sort_order=6)
                    session.add_all([tech_cat, news_cat, backend_cat, design_cat, geek_cat, general_cat])
                    await session.flush()
                    categories = [tech_cat, news_cat, backend_cat, design_cat, geek_cat, general_cat]
                    print("[Database] 初始核心版块分类已自动注入！")
                else:
                    has_general = any(c.slug == "general" or c.name == "综合交流" for c in categories)
                    if not has_general:
                        general_cat = Category(name="综合交流", slug="general", description="极客茶水间与闲聊讨论", sort_order=6)
                        session.add(general_cat)
                        await session.flush()
                        categories.append(general_cat)
                        print("[Database] 增量注入核心版块分类：综合交流")

                # 仅在无任何帖子时注入 1 篇真实官方公告
                post_res = await session.execute(select(Post))
                if not post_res.scalars().first() and admin_user:
                    first_cat = categories[0] if categories else None
                    welcome_post = Post(
                        author_id=admin_user.id,
                        category_id=first_cat.id if first_cat else None,
                        title="【社区公告】社区 4.0 钛金属黑白极简版本正式上线发布",
                        content_md="""### 各位先锋极客好！

社区 4.0 纯黑白钛金属版本现已正式部署就绪。

1. **纯黑白冷曜石美学**：摒弃杂色干扰，专注技术创作与深度工程讨论；
2. **多技术标签体系**：支持文章添加自定义标签与一键分类检索；
3. **极客关注流**：可自由关注创作者，实时聚合优质原创动态；
4. **全链路通知中心**：互动、点赞与关注动态秒级触达。

欢迎点击右上角发表你的第一篇技术讨论！""",
                        content_html="<p>欢迎来到极客社区！社区 4.0 纯黑白钛金属版本现已正式部署就绪...</p>",
                        post_type="news",
                        status="published",
                        is_pinned=True,
                        tags="公告,技术前沿,架构设计",
                        view_count=1,
                        like_count=0,
                        comment_count=0
                    )
                    session.add(welcome_post)

                # 自动注入默认社区规则与经验限制配置
                from app.models.system import SystemSetting, CommunityRule
                from app.core.default_rules import DEFAULT_RULES_TITLE, DEFAULT_RULES_CONTENT
                for default_key, default_val, default_desc in [
                    ("daily_post_limit", "5", "普通用户每日文章发布篇数上限（超管与管理员免限）"),
                    ("daily_exp_limit", "60", "用户每日最高经验获取上限"),
                    ("post_exp_reward", "15", "发布一篇合格文章奖励经验值"),
                ]:
                    st_res = await session.execute(select(SystemSetting).where(SystemSetting.key == default_key))
                    if not st_res.scalar_one_or_none():
                        session.add(SystemSetting(key=default_key, value=default_val, description=default_desc))

                rule_check = await session.execute(select(CommunityRule).limit(1))
                if not rule_check.scalar_one_or_none():
                    session.add(CommunityRule(
                        title=DEFAULT_RULES_TITLE,
                        content=DEFAULT_RULES_CONTENT,
                        version=1
                    ))

                await session.commit()

            print("[Database] 数据库连接与表结构初始化成功！")
            break
        except Exception as e:
            retries -= 1
            print(f"[Database] 等待数据库就绪中... 剩余重试 {retries} 次 (原因: {e})")
            if retries <= 0:
                raise
            await asyncio.sleep(2)

    
    # 2. 连接 Redis / 内存 Mock，并在真实 Redis 下启用多实例 WS 事件桥接
    await init_redis()
    try:
        from app.core.database import redis_client
        from app.services.ws_manager import ws_manager
        await ws_manager.start_fanout(redis_client)
    except Exception as e:
        print(f"[WS Fanout Warning] 跨实例广播未启用: {e}")

    # 3. 启动轻量定时任务 (APScheduler)
    try:
        # 幂等播种内置勋章定义（新增补齐，已有不覆盖）
        try:
            from app.services.achievement_service import ensure_achievement_defs
            created_defs = await ensure_achievement_defs()
            if created_defs:
                print(f"[Achievement] 已初始化 {created_defs} 条内置勋章定义")
        except Exception as e:
            print(f"[Achievement] 勋章定义初始化失败（可忽略）: {e}")

        start_scheduler()
    except Exception as e:
        print(f"[Scheduler Warning] {e}")
    
    yield
    
    # 4. 关闭清理
    try:
        stop_scheduler()
    except Exception:
        pass
    try:
        from app.services.ws_manager import ws_manager
        await ws_manager.stop_fanout()
    except Exception:
        pass
    await close_redis()

# 生产环境默认关闭交互式文档，需要时在 .env 设置 ENABLE_API_DOCS=1
_docs_enabled = bool(settings.ENABLE_API_DOCS) or settings.ENVIRONMENT != "production"

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
    docs_url="/api/docs" if _docs_enabled else None,
    openapi_url="/api/openapi.json" if _docs_enabled else None,
    redoc_url=None,
)

# 跨域白名单：默认不允许跨域（前端与 API 同源部署时无需 CORS）
_cors_origins = [o.strip() for o in (settings.CORS_ORIGINS or "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# APM 链路性能监控与慢请求告警中间件
import time
from collections import deque
@app.middleware("http")
async def performance_and_slow_query_apm_middleware(request, call_next):
    start_time = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start_time) * 1000.0
    response.headers["X-Process-Time"] = f"{duration_ms:.2f}ms"
    if duration_ms > 500.0:
        print(f"[APM SLOW WARNING] {request.method} {request.url.path} 响应耗时: {duration_ms:.2f}ms")
    # 运维面板计数：仅统计 API 请求，内存累加后定时落库（零额外 DB 写入）
    try:
        path = request.url.path
        if path.startswith("/api") and not path.startswith(("/api/ops/visit", "/api/healthz", "/api/docs", "/api/openapi")):
            from app.services.ops_service import note_api
            note_api(response.status_code, duration_ms)
    except Exception:
        pass
    # 评论分页信息透出（由评论路由写入 request.state）
    if getattr(request.state, "comments_has_more", None) is not None:
        response.headers["X-Comments-Has-More"] = request.state.comments_has_more
        response.headers["X-Comments-Total"] = str(getattr(request.state, "comments_total", 0))
    return response


# 公开图片分发接口：响应本身带 30 天强缓存头，不能被下面的 no-store 覆盖。
# 否则每刷新一次页面都会重新拉几十张头像/缩略图，既拖慢首屏又容易撞上 nginx 限流（429）。
_CACHEABLE_IMAGE_API_PREFIXES = (
    "/api/users/avatar",
    "/api/media/proxy",
    "/api/posts/media/compat/",
)

# 所有 API 响应统一禁止缓存：大量接口返回带用户身份的数据（/auth/me、通知、私信、管理端统计），
# 一旦被中间代理或浏览器缓存，切换账号后可能读到上一个账号的数据
@app.middleware("http")
async def no_store_for_api_middleware(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api") and not request.url.path.startswith(_CACHEABLE_IMAGE_API_PREFIXES):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
    if response.status_code >= 500:
        await record_server_error()
    return response


# 静态文件服务 (上传图片预览)
if not os.path.exists(settings.UPLOAD_DIR):
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

# 挂载业务路由
app.include_router(auth.router, prefix=settings.API_V1_STR)
app.include_router(users.router, prefix=settings.API_V1_STR)
app.include_router(posts.router, prefix=settings.API_V1_STR)
app.include_router(comments.router, prefix=settings.API_V1_STR)
app.include_router(polls.router, prefix=settings.API_V1_STR)
app.include_router(chat.router, prefix=settings.API_V1_STR)
app.include_router(reactions.router, prefix=settings.API_V1_STR)
app.include_router(admin.router, prefix=settings.API_V1_STR)
app.include_router(feedback.router, prefix=settings.API_V1_STR)
app.include_router(rules.router, prefix=settings.API_V1_STR)
app.include_router(ops.router, prefix=settings.API_V1_STR)
app.include_router(ops.admin_router, prefix=settings.API_V1_STR)
app.include_router(search.router, prefix=settings.API_V1_STR)
app.include_router(achievements.router, prefix=settings.API_V1_STR)
app.include_router(achievements.admin_router, prefix=settings.API_V1_STR)
app.include_router(sensitive_words_admin.router, prefix=settings.API_V1_STR)
app.include_router(friend_links.router, prefix=settings.API_V1_STR)
app.include_router(friend_links.admin_router, prefix=settings.API_V1_STR)
app.include_router(stats.router, prefix=settings.API_V1_STR)
app.include_router(minigames.router, prefix=settings.API_V1_STR)
app.include_router(battles.router, prefix=settings.API_V1_STR)
app.include_router(ai_admin.router, prefix=settings.API_V1_STR)
app.include_router(ai_admin.admin_router, prefix=settings.API_V1_STR)
app.include_router(site_contents.router, prefix=settings.API_V1_STR)
app.include_router(group_activities.router, prefix=settings.API_V1_STR)
app.include_router(qa.router, prefix=settings.API_V1_STR)
app.include_router(media.router, prefix=settings.API_V1_STR)
app.include_router(meta.router, prefix=settings.API_V1_STR)
app.include_router(stickers.router, prefix=settings.API_V1_STR)
app.include_router(food.router, prefix=settings.API_V1_STR)
app.include_router(doudizhu.router, prefix=settings.API_V1_STR)
app.include_router(doudizhu_points.router, prefix=settings.API_V1_STR)
app.include_router(draw_guess.router, prefix=settings.API_V1_STR)
app.include_router(habits.router, prefix=settings.API_V1_STR)

# 最近 5 分钟的 5xx 计数：供 healthz 判断「接口是否在大面积报错」。
# 站点整体可访问、但接口全是 500 的情况下，外部监控只能靠这个发现。
_ERR5XX: "deque[float]" = deque(maxlen=2000)


async def record_server_error() -> None:
    """记录一次 5xx。内存 deque 只在单 worker 有效，优先写 Redis 分钟桶做跨 worker 汇总。"""
    _ERR5XX.append(time.monotonic())
    try:
        redis = get_redis()
        if redis:
            bucket = f"wb:err5xx:{int(time.time() // 60)}"
            await redis.incr(bucket)
            await redis.expire(bucket, 600)
    except Exception:
        pass


async def recent_5xx_count(window_seconds: int = 300) -> int:
    """最近 5 分钟 5xx 数：Redis 分钟桶优先，Redis 不可用时回退进程内存。"""
    try:
        redis = get_redis()
        if redis:
            now_min = int(time.time() // 60)
            minutes = max(1, window_seconds // 60)
            total = 0
            for m in range(minutes):
                v = await redis.get(f"wb:err5xx:{now_min - m}")
                if v:
                    total += int(v.decode() if isinstance(v, bytes) else v)
            return total
    except Exception:
        pass
    cutoff = time.monotonic() - window_seconds
    return sum(1 for t in _ERR5XX if t >= cutoff)


# 健康探针：DB 不通直接 503（供 Docker healthcheck / 外部监控使用），Redis 不可用时降级告警
@app.get("/api/healthz")
async def health_check(response: Response):
    from app.core.database import engine, get_redis

    db_ok = True
    redis_state = "ok"
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1;"))
    except Exception:
        db_ok = False

    redis = get_redis()
    if not redis:
        redis_state = "missing"
    else:
        try:
            await redis.ping()
        except Exception:
            redis_state = "unavailable"

    # 大面积 5xx 也视为不健康：让 Kuma 的「站点可访问」探测能发现接口层故障
    err_5xx = await recent_5xx_count()
    healthy = db_ok and err_5xx < 20
    if not healthy:
        response.status_code = 503
    return {
        "status": "healthy" if healthy else "unhealthy",
        "database": "ok" if db_ok else "unavailable",
        # Redis 运行时故障会退化为单机内存模式，不阻断流量，但需要告警
        "redis": redis_state,
        "version": settings.VERSION,
        "environment": settings.ENVIRONMENT,
    }

def _public_base(request: Request) -> str:
    """站点对外地址：优先 PUBLIC_SITE_URL，其次按反代头推导。"""
    if settings.PUBLIC_SITE_URL:
        return settings.PUBLIC_SITE_URL.rstrip("/")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt(request: Request):
    base = _public_base(request)
    return Response(
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /uploads/\n"
        "Disallow: /*?tab=admin\n"
        "\n"
        f"Sitemap: {base}/sitemap.xml\n",
        media_type="text/plain; charset=utf-8",
    )


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap_xml(request: Request):
    from app.core.database import AsyncSessionLocal
    from app.models.post import Post

    from app.core.cache import get_cached_json, set_cached_json

    base = _public_base(request)
    urls = [f"{base}/", f"{base}/?tab=rules"]

    # 爬虫会频繁抓取；文章列表 10 分钟内变化不大，缓存 URL 列表避免每次扫 5000 行
    post_entries = await get_cached_json("cache:seo:post_urls")
    if post_entries is None:
        post_entries = []
        try:
            async with AsyncSessionLocal() as session:
                rows = (await session.execute(
                    select(Post.id, Post.updated_at)
                    .where(Post.status == "published")
                    .order_by(Post.created_at.desc())
                    .limit(5000)
                )).all()
            post_entries = [
                [str(pid), updated.strftime("%Y-%m-%d") if updated else ""]
                for pid, updated in rows
            ]
            await set_cached_json("cache:seo:post_urls", post_entries, ttl=600)
        except Exception:
            post_entries = []

    for pid, lastmod in post_entries:
        urls.append(f"{base}/p/{pid}" + (f"|{lastmod}" if lastmod else ""))

    body = []
    for item in urls:
        if "|" in item:
            loc, lastmod = item.split("|", 1)
            body.append(f"<url><loc>{loc}</loc><lastmod>{lastmod}</lastmod><changefreq>weekly</changefreq></url>")
        else:
            body.append(f"<url><loc>{item}</loc><changefreq>daily</changefreq></url>")

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + "".join(body)
        + "</urlset>"
    )
    return Response(xml, media_type="application/xml; charset=utf-8")


@app.get("/rss.xml", include_in_schema=False)
async def rss_feed(request: Request):
    from app.core.database import AsyncSessionLocal
    from app.models.post import Post

    from app.core.cache import get_cached_json, set_cached_json

    base = _public_base(request)
    cache_key = f"cache:seo:rss:{base}"
    items = await get_cached_json(cache_key)

    if items is None:
        try:
            async with AsyncSessionLocal() as session:
                posts = (await session.execute(
                    select(Post)
                    .where(Post.status == "published")
                    .order_by(Post.created_at.desc())
                    .limit(30)
                )).scalars().all()
        except Exception:
            posts = []

        def _esc(text: str) -> str:
            return html.escape((text or "").strip())

        items = []
        for p in posts:
            summary = re.sub(r"[#*`>_~-]", " ", (p.content_md or ""))[:180].replace("]]>", "]]&gt;")
            pub = p.created_at.strftime("%a, %d %b %Y %H:%M:%S +0000") if p.created_at else ""
            items.append(
                "<item>"
                f"<title>{_esc(p.title)}</title>"
                f"<link>{base}/p/{p.id}</link>"
                f"<guid isPermaLink=\"true\">{base}/p/{p.id}</guid>"
                f"<pubDate>{pub}</pubDate>"
                f"<description><![CDATA[{summary}]]></description>"
                "</item>"
            )
        await set_cached_json(cache_key, items, ttl=600)

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<rss version="2.0"><channel>'
        f"<title>极客社区 · 最新文章</title>"
        f"<link>{base}/</link>"
        "<description>现代技术架构与工程实践社区</description>"
        "<language>zh-CN</language>"
        + "".join(items)
        + "</channel></rss>"
    )
    return Response(xml, media_type="application/rss+xml; charset=utf-8")


# 社交媒体 OpenGraph / Twitter Cards SEO 动态预览与秒跳页面
from fastapi.responses import HTMLResponse
import html
import re
import uuid
from app.core.database import AsyncSessionLocal
from app.models.post import Post
from fastapi import Request, Response

def generate_post_og_html(post: Post, base_url: str = "") -> str:
    plain_text = re.sub(r'#+\s+', '', post.content_md or '')
    plain_text = re.sub(r'!\[.*?\]\(.*?\)', '', plain_text)
    plain_text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', plain_text)
    plain_text = re.sub(r'[`*~_>#-]', ' ', plain_text)
    summary = " ".join(plain_text.split())[:160]
    if not summary:
        summary = "来自深度极客社区的一篇日常记录。"

    title = html.escape(post.title or "社区文章")
    # 对正文清洗后的摘要进行二次 html.escape 转义，杜绝 XSS 风险
    escaped_summary = html.escape(summary)

    cover_image = post.cover_image or ""
    if cover_image and not cover_image.startswith("http"):
        cover_image = f"{base_url.rstrip('/')}{cover_image if cover_image.startswith('/') else '/' + cover_image}"

    target_url = f"/?post={post.id}"
    full_target_url = f"{base_url.rstrip('/')}{target_url}"

    image_tag = f'<meta property="og:image" content="{html.escape(cover_image)}">' if cover_image else ''
    twitter_image = f'<meta name="twitter:image" content="{html.escape(cover_image)}">' if cover_image else ''
    twitter_card = "summary_large_image" if cover_image else "summary"

    # JSON-LD 结构化数据：让搜索引擎知道这是一篇文章（标题/时间/封面）
    import json
    ld_payload = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": post.title or "社区文章",
        "description": summary,
        "url": full_target_url,
        "mainEntityOfPage": {"@type": "WebPage", "@id": full_target_url},
        "inLanguage": "zh-CN",
        "publisher": {
            "@type": "Organization",
            "name": "深度极客社区",
            "logo": {"@type": "ImageObject", "url": f"{base_url.rstrip('/')}/logo.png"},
        },
    }
    if cover_image:
        ld_payload["image"] = cover_image
    created_at = getattr(post, "created_at", None)
    if created_at:
        ld_payload["datePublished"] = created_at.isoformat()
    updated_at = getattr(post, "updated_at", None)
    if updated_at:
        ld_payload["dateModified"] = updated_at.isoformat()
    # "</" 转义，避免正文中出现闭合标签破坏 script 块
    ld_json = json.dumps(ld_payload, ensure_ascii=False).replace("</", "<\\/")

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title} - 极客技术社区</title>
  <meta name="description" content="{escaped_summary}">

  <!-- OpenGraph Meta Tags (WeChat, Telegram, Discord, Slack, etc.) -->
  <meta property="og:site_name" content="深度极客社区">
  <meta property="og:type" content="article">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{escaped_summary}">
  <meta property="og:url" content="{full_target_url}">
  <meta property="og:locale" content="zh_CN">
  {image_tag}

  <!-- Twitter / X Cards -->
  <meta name="twitter:card" content="{twitter_card}">
  <meta name="twitter:title" content="{title}">
  <meta name="twitter:description" content="{escaped_summary}">
  {twitter_image}

  <!-- 结构化数据 -->
  <script type="application/ld+json">{ld_json}</script>

  <!-- Instant Redirect for Real Users -->
  <meta http-equiv="refresh" content="0; url={target_url}">
  <script>
    window.location.replace("{target_url}");
  </script>
  <style>
    body {{
      background-color: #09090b;
      color: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 1.5rem;
      box-sizing: border-box;
      text-align: center;
    }}
    .box {{
      max-width: 520px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 2rem;
      background: rgba(255, 255, 255, 0.03);
    }}
    h1 {{ font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; }}
    p {{ font-size: 0.875rem; color: #a1a1aa; line-height: 1.5; margin-bottom: 1.5rem; }}
    a {{
      color: #38bdf8;
      text-decoration: none;
      font-weight: 500;
      border-bottom: 1px dashed #38bdf8;
      padding-bottom: 2px;
    }}
  </style>
</head>
<body>
  <div class="box">
    <h1>{title}</h1>
    <p>{escaped_summary}</p>
    <div>正在为你跳转至社区正文... 若未自动跳转，请<a href="{target_url}">点击这里</a></div>
  </div>
</body>
</html>"""

@app.get("/p/{post_id}", response_class=HTMLResponse)
@app.get("/share/posts/{post_id}", response_class=HTMLResponse)
@app.get("/api/v1/posts/{post_id}/og", response_class=HTMLResponse)
async def post_share_opengraph_page(post_id: str, request: Request):
    try:
        pid = uuid.UUID(post_id)
    except ValueError:
        return HTMLResponse("<html><head><meta http-equiv='refresh' content='0; url=/'></head><body>Invalid Post ID</body></html>", status_code=400)

    base_url = str(request.base_url).rstrip('/')
    async with AsyncSessionLocal() as session:
        # 分享页只允许公开文章，草稿/定时/已删除一律按未找到处理，避免泄漏未发布内容
        stmt = select(Post).where(Post.id == pid, Post.status == "published")
        res = await session.execute(stmt)
        post = res.scalar_one_or_none()
        if not post:
            return HTMLResponse("<html><head><meta http-equiv='refresh' content='0; url=/'></head><body>Post Not Found</body></html>", status_code=404)
        
        return HTMLResponse(generate_post_og_html(post, base_url))

