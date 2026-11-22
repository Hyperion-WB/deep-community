"""站点运维统计服务

- 页面访问（PV/UV/热门页面）：由前端埋点上报，落 site_visits 明细表
- 接口请求（总量/错误/慢请求/平均耗时）：中间件在内存累加，定时批量落 site_metrics_daily
- 系统信息（内存/负载/磁盘/数据库体积/Redis/调度任务）：实时读取，不做持久化

设计目标：不引入新依赖（不装 psutil），不增加每个请求的 DB 写入，
单 worker + 小内存部署下也能安全使用。
"""

import hashlib
import os
import shutil
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.database import AsyncSessionLocal, engine, get_redis
from app.core.timezone import utc_now
from app.models.comment import Comment
from app.models.ops import SiteMetricDaily, SiteVisit
from app.models.post import Post
from app.models.system import Report
from app.models.user import User

BIZ_TZ = timezone(timedelta(hours=8))
VISIT_RETENTION_DAYS = 60
PROCESS_START_TS = time.time()

# 当日 API 计数缓冲：{day: {...}}，由调度任务每 30 秒刷入数据库
_api_buffer: Dict[str, Dict[str, int]] = {}

# 访问去重：同一访客 30 秒内重复访问同一路径只计一次（防刷新刷量/机器人灌库）
VISIT_DEDUPE_SECONDS = 30
_dedupe_fallback: Dict[str, float] = {}


async def _allow_visit(visitor: str, path: str) -> bool:
    key = f"wb:ops:pv:{visitor}:{abs(hash(path)) % (10 ** 12)}"
    try:
        redis = get_redis()
        # 注意：SET NX 在键已存在时返回 None，这是「已去重」而不是「Redis 不可用」，
        # 必须与异常区分，否则会退回到进程内兜底并把重复访问重新放行。
        result = await redis.set(key, "1", ex=VISIT_DEDUPE_SECONDS, nx=True)
        return bool(result)
    except Exception:
        pass
    now = time.time()
    last = _dedupe_fallback.get(key)
    if last and now - last < VISIT_DEDUPE_SECONDS:
        return False
    if len(_dedupe_fallback) > 5000:
        _dedupe_fallback.clear()
    _dedupe_fallback[key] = now
    return True


def biz_day(dt: Optional[datetime] = None) -> str:
    """业务日（Asia/Shanghai），与签到/经验口径保持一致"""
    return (dt or utc_now()).astimezone(BIZ_TZ).strftime("%Y-%m-%d")


def biz_day_shift(days: int) -> str:
    return (utc_now().astimezone(BIZ_TZ) - timedelta(days=days)).strftime("%Y-%m-%d")


def visitor_hash(ip: str, ua: str, day: str) -> str:
    raw = f"{day}|{ip}|{ua}".encode("utf-8", "ignore")
    return hashlib.sha256(raw).hexdigest()[:32]


def note_api(status_code: int, duration_ms: float) -> None:
    """中间件调用：内存累加，避免每请求写库"""
    day = biz_day()
    bucket = _api_buffer.setdefault(day, {"requests": 0, "errors": 0, "slow": 0, "duration_ms": 0})
    bucket["requests"] += 1
    bucket["duration_ms"] += int(duration_ms)
    if status_code >= 500:
        bucket["errors"] += 1
    if duration_ms >= 500:
        bucket["slow"] += 1


async def record_page_view(path: str, ip: str, ua: str) -> bool:
    day = biz_day()
    visitor = visitor_hash(ip, ua, day)
    if not await _allow_visit(visitor, path):
        return False
    async with AsyncSessionLocal() as db:
        db.add(
            SiteVisit(
                day=day,
                path=(path or "/")[:255],
                kind="page",
                visitor_hash=visitor,
            )
        )
        await db.commit()
    return True


async def _content_counts() -> Dict[str, int]:
    async with AsyncSessionLocal() as db:
        users = await db.scalar(select(func.count(User.id)).where(User.status != "deleted"))
        posts = await db.scalar(select(func.count(Post.id)).where(Post.status == "published"))
        comments = await db.scalar(select(func.count(Comment.id)).where(Comment.status == "visible"))
    return {"users": int(users or 0), "posts": int(posts or 0), "comments": int(comments or 0)}


async def flush_metrics() -> None:
    """把内存中的 API 计数与内容存量快照刷入当日汇总行"""
    global _api_buffer
    if not _api_buffer:
        return
    snapshot = _api_buffer
    _api_buffer = {}
    counts = await _content_counts()

    async with AsyncSessionLocal() as db:
        for day, bucket in snapshot.items():
            # 多 worker 并发 flush 时，"先读后写"会互相覆盖导致少计；
            # 改为单条 INSERT ... ON CONFLICT DO UPDATE 原子累加。
            stmt = pg_insert(SiteMetricDaily).values(
                day=day,
                api_requests=bucket["requests"],
                api_errors=bucket["errors"],
                api_slow=bucket["slow"],
                api_duration_ms=bucket["duration_ms"],
                users_total=counts["users"],
                posts_total=counts["posts"],
                comments_total=counts["comments"],
            ).on_conflict_do_update(
                index_elements=[SiteMetricDaily.day],
                set_={
                    "api_requests": SiteMetricDaily.api_requests + bucket["requests"],
                    "api_errors": SiteMetricDaily.api_errors + bucket["errors"],
                    "api_slow": SiteMetricDaily.api_slow + bucket["slow"],
                    "api_duration_ms": SiteMetricDaily.api_duration_ms + bucket["duration_ms"],
                    "users_total": counts["users"],
                    "posts_total": counts["posts"],
                    "comments_total": counts["comments"],
                },
            )
            await db.execute(stmt)
        await db.commit()


async def purge_old_visits(days: int = VISIT_RETENTION_DAYS) -> int:
    cutoff = utc_now() - timedelta(days=days)
    async with AsyncSessionLocal() as db:
        result = await db.execute(delete(SiteVisit).where(SiteVisit.created_at < cutoff))
        await db.commit()
        return int(result.rowcount or 0)


async def _visit_aggregate(day_from: str, day_to: str) -> Dict[str, Dict[str, int]]:
    async with AsyncSessionLocal() as db:
        rows = await db.execute(
            select(
                SiteVisit.day,
                func.count(SiteVisit.id),
                func.count(func.distinct(SiteVisit.visitor_hash)),
            )
            .where(SiteVisit.kind == "page", SiteVisit.day >= day_from, SiteVisit.day <= day_to)
            .group_by(SiteVisit.day)
        )
        return {str(day): {"pv": int(pv or 0), "uv": int(uv or 0)} for day, pv, uv in rows.all()}


async def get_visit_today() -> Dict[str, int]:
    today = biz_day()
    agg = await _visit_aggregate(today, today)
    return agg.get(today, {"pv": 0, "uv": 0})


async def get_trend(days: int = 14) -> List[Dict[str, Any]]:
    days = max(1, min(days, 90))
    day_from = biz_day_shift(days - 1)
    day_to = biz_day()
    visits = await _visit_aggregate(day_from, day_to)

    async with AsyncSessionLocal() as db:
        rows = await db.execute(
            select(SiteMetricDaily).where(SiteMetricDaily.day >= day_from, SiteMetricDaily.day <= day_to)
        )
        metrics = {row.day: row for row in rows.scalars().all()}

    buffer_today = _api_buffer.get(day_to, {})
    series: List[Dict[str, Any]] = []
    for offset in range(days - 1, -1, -1):
        day = biz_day_shift(offset)
        m = metrics.get(day)
        req = int(m.api_requests) if m else 0
        err = int(m.api_errors) if m else 0
        slow = int(m.api_slow) if m else 0
        dur = int(m.api_duration_ms) if m else 0
        if day == day_to:
            req += buffer_today.get("requests", 0)
            err += buffer_today.get("errors", 0)
            slow += buffer_today.get("slow", 0)
            dur += buffer_today.get("duration_ms", 0)
        series.append(
            {
                "day": day,
                "pv": visits.get(day, {}).get("pv", 0),
                "uv": visits.get(day, {}).get("uv", 0),
                "api_requests": req,
                "api_errors": err,
                "api_slow": slow,
                "avg_ms": round(dur / req, 1) if req else 0,
                "users_total": int(m.users_total) if m else 0,
                "posts_total": int(m.posts_total) if m else 0,
                "comments_total": int(m.comments_total) if m else 0,
            }
        )
    return series


async def get_top_pages(days: int = 7, limit: int = 10) -> List[Dict[str, Any]]:
    days = max(1, min(days, 90))
    limit = max(1, min(limit, 50))
    day_from = biz_day_shift(days - 1)
    async with AsyncSessionLocal() as db:
        # 把 /p/<uuid>、/u/<name> 之类的动态段归并成 /p/:id，避免 Top10 被单篇帖子刷屏
        path_expr = SiteVisit.path
        if engine.dialect.name == "postgresql":
            path_expr = func.regexp_replace(
                SiteVisit.path,
                r"/p/[0-9a-fA-F-]{16,36}",
                "/p/:id",
                "g",
            )
        rows = await db.execute(
            select(path_expr.label("path"), func.count(SiteVisit.id))
            .where(SiteVisit.kind == "page", SiteVisit.day >= day_from)
            .group_by(path_expr)
            .order_by(func.count(SiteVisit.id).desc())
            .limit(limit)
        )
        return [{"path": path, "pv": int(pv or 0)} for path, pv in rows.all()]


def _read_meminfo() -> Dict[str, int]:
    info: Dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                parts = rest.strip().split()
                if parts:
                    info[key] = int(parts[0]) // 1024  # kB -> MB
    except Exception:
        pass
    return info


def _read_cgroup_limit_mb() -> Optional[int]:
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read().strip()
            if raw and raw != "max":
                value = int(raw)
                if value > 0 and value < 10**15:
                    return value // (1024 * 1024)
        except Exception:
            continue
    return None


def _read_cgroup_usage_mb() -> Optional[int]:
    for path in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return int(fh.read().strip()) // (1024 * 1024)
        except Exception:
            continue
    return None


async def get_system_info() -> Dict[str, Any]:
    mem = _read_meminfo()
    info: Dict[str, Any] = {
        "uptime_seconds": int(time.time() - PROCESS_START_TS),
        "started_at": datetime.fromtimestamp(PROCESS_START_TS, tz=timezone.utc).isoformat(),
        "host_mem_total_mb": mem.get("MemTotal", 0),
        "host_mem_available_mb": mem.get("MemAvailable", 0),
        "host_swap_total_mb": mem.get("SwapTotal", 0),
        "host_swap_free_mb": mem.get("SwapFree", 0),
        "container_mem_limit_mb": _read_cgroup_limit_mb(),
        "container_mem_used_mb": _read_cgroup_usage_mb(),
        "cpu_count": os.cpu_count() or 1,
        "environment": os.getenv("ENVIRONMENT", ""),
    }

    try:
        info["load_avg"] = [round(x, 2) for x in os.getloadavg()]
    except Exception:
        info["load_avg"] = [0, 0, 0]

    try:
        usage = shutil.disk_usage("/")
        info["disk_total_gb"] = round(usage.total / 1024**3, 1)
        info["disk_used_gb"] = round(usage.used / 1024**3, 1)
        info["disk_percent"] = round(usage.used / usage.total * 100, 1)
    except Exception:
        info["disk_total_gb"] = info["disk_used_gb"] = info["disk_percent"] = 0

    try:
        async with engine.begin() as conn:
            if conn.dialect.name == "postgresql":
                size = await conn.scalar(text("SELECT pg_database_size(current_database())"))
                info["db_size_mb"] = round((size or 0) / 1024 / 1024, 1)
            else:
                info["db_size_mb"] = 0
    except Exception:
        info["db_size_mb"] = 0

    try:
        redis = get_redis()
        await redis.ping()
        info["redis_ok"] = True
    except Exception:
        info["redis_ok"] = False

    try:
        from app.tasks.scheduler import scheduler
        info["scheduler_running"] = bool(scheduler.running)
        info["scheduler_jobs"] = [
            {
                "id": job.id,
                "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
            }
            for job in scheduler.get_jobs()
        ]
    except Exception:
        info["scheduler_running"] = False
        info["scheduler_jobs"] = []

    return info


async def get_overview() -> Dict[str, Any]:
    today = biz_day()
    visits = await get_visit_today()
    buffer_today = _api_buffer.get(today, {})

    async with AsyncSessionLocal() as db:
        metric = await db.get(SiteMetricDaily, today)
        pending_reports = await db.scalar(
            select(func.count(Report.id)).where(Report.status == "pending")
        )
        users = await db.scalar(select(func.count(User.id)).where(User.status != "deleted"))
        posts = await db.scalar(select(func.count(Post.id)).where(Post.status == "published"))
        comments = await db.scalar(select(func.count(Comment.id)).where(Comment.status == "visible"))

    req = int(metric.api_requests) if metric else 0
    err = int(metric.api_errors) if metric else 0
    slow = int(metric.api_slow) if metric else 0
    dur = int(metric.api_duration_ms) if metric else 0
    req += buffer_today.get("requests", 0)
    err += buffer_today.get("errors", 0)
    slow += buffer_today.get("slow", 0)
    dur += buffer_today.get("duration_ms", 0)

    return {
        "day": today,
        "today": {
            "pv": visits.get("pv", 0),
            "uv": visits.get("uv", 0),
            "api_requests": req,
            "api_errors": err,
            "api_slow": slow,
            "avg_ms": round(dur / req, 1) if req else 0,
        },
        "totals": {
            "users": int(users or 0),
            "posts": int(posts or 0),
            "comments": int(comments or 0),
            "pending_reports": int(pending_reports or 0),
        },
        "system": await get_system_info(),
        "generated_at": utc_now().isoformat(),
    }
