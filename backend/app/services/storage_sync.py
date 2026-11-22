"""本地优先 + 对象存储异步镜像。

设计目标
--------
1. 上传只写本地磁盘就立刻返回，用户不会因为对象存储慢而等待；
2. 镜像任务**持久化**在 Redis 集合里，进程重启/发布不会丢；
3. 失败自动重试（定时任务兜底），不依赖进程内的 asyncio task；
4. 读取优先本地，本地缺失时由 nginx 回源对象存储（见 nginx.conf @s3_mirror）。

为什么不用数据库表：这里追求的是"上传零额外延迟"，一次 Redis SADD 比
一次 DB 事务轻得多；即使 Redis 丢了这个集合，最坏结果是某些图不再补传，
已同步的部分不受影响，且本地始终是权威副本。
"""

import os
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.core.database import get_redis

# 待镜像集合：成员格式 "{object_key}|{content_type}"
MIRROR_PENDING_KEY = "storage:mirror:pending"
# 单次补传上限，避免一轮任务占用过多带宽/CPU
MIRROR_BATCH = 40


def _mirror_ready() -> bool:
    """镜像是否可用（延迟导入避免与 image_service 互相 import）。"""
    try:
        from app.services.image_service import is_mirror_enabled

        return is_mirror_enabled()
    except Exception:
        return False


def _local_path(object_key: str) -> str:
    """uploads/2026/11/x.webp → {UPLOAD_DIR}/2026/11/x.webp"""
    key = (object_key or "").lstrip("/")
    if key.startswith("uploads/"):
        key = key[len("uploads/"):]
    return os.path.join(settings.UPLOAD_DIR, key)


async def enqueue_mirror(object_key: str, content_type: str = "image/webp") -> None:
    """把待镜像的文件登记到 Redis 集合。

    只做一次 SADD，耗时在亚毫秒级，不会影响上传响应时间。
    任何异常都吞掉：镜像失败绝不能影响用户上传。
    """
    if not object_key or not _mirror_ready():
        return
    try:
        redis = get_redis()
        if not redis:
            return
        await redis.sadd(MIRROR_PENDING_KEY, f"{object_key}|{content_type}")
    except Exception:
        pass


async def _dequeue(object_key: str, content_type: str) -> None:
    try:
        redis = get_redis()
        if redis:
            await redis.srem(MIRROR_PENDING_KEY, f"{object_key}|{content_type}")
    except Exception:
        pass


def _upload_blocking(object_key: str, data: bytes, content_type: str) -> bool:
    """同步上传（在线程池里跑，避免阻塞事件循环）。"""
    from app.services.image_service import get_s3_client, sync_upload_bytes_to_s3

    client = get_s3_client()
    if not client:
        return False
    return bool(
        sync_upload_bytes_to_s3(client, settings.S3_BUCKET, object_key, data, content_type)
    )


async def mirror_one(object_key: str, content_type: str = "image/webp") -> bool:
    """把单个本地文件补传到对象存储；成功返回 True。"""
    if not _mirror_ready():
        return False
    path = _local_path(object_key)
    try:
        if not os.path.exists(path):
            # 本地已经没有这个文件（被清理/删除），没必要再镜像
            await _dequeue(object_key, content_type)
            return True
        import asyncio

        with open(path, "rb") as f:
            data = f.read()
        return await asyncio.to_thread(_upload_blocking, object_key, data, content_type)
    except Exception as exc:
        print(f"[Storage] 镜像失败 key={object_key}: {type(exc).__name__} {str(exc)[:120]}")
        return False


async def process_pending(limit: int = MIRROR_BATCH) -> Dict[str, Any]:
    """定时任务入口：把积压的待镜像文件补传掉。

    成功即出队；失败保留在集合里，下一轮继续。
    """
    stats = {"pending": 0, "ok": 0, "failed": 0, "skipped": False}
    if not _mirror_ready():
        stats["skipped"] = True
        return stats
    try:
        redis = get_redis()
        if not redis:
            stats["skipped"] = True
            return stats
        members: List[str] = list(await redis.smembers(MIRROR_PENDING_KEY) or [])
    except Exception:
        stats["skipped"] = True
        return stats

    stats["pending"] = len(members)
    # 先处理最早入库的：Redis 集合无序，这里按字符串排序保证大致稳定
    for item in sorted(members)[:limit]:
        key, _, ctype = item.partition("|")
        ok = await mirror_one(key, ctype or "image/webp")
        if ok:
            await _dequeue(key, ctype or "image/webp")
            stats["ok"] += 1
        else:
            stats["failed"] += 1
    return stats


async def pending_count() -> int:
    try:
        redis = get_redis()
        return int(await redis.scard(MIRROR_PENDING_KEY)) if redis else 0
    except Exception:
        return 0


def resolve_local_path(url: str) -> Optional[str]:
    """把 /uploads/... 的访问地址解析成本地绝对路径（供回源接口使用）。"""
    if not url:
        return None
    key = url.split("?")[0].lstrip("/")
    if not key.startswith("uploads/"):
        return None
    # 防目录穿越
    if ".." in key:
        return None
    return os.path.join(settings.UPLOAD_DIR, key[len("uploads/"):])
