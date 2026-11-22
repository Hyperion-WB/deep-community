import time
import os
from typing import AsyncGenerator, Optional
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from app.core.config import settings

# 生产环境统一使用 PostgreSQL（已移除 SQLite 兼容分支）
# 双 worker 场景下：每个进程 8+7=15 条连接，合计 30，低于 PostgreSQL max_connections=40，
# 给备份 pg_dump、运维 psql 以及连接回收留出余量。
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=8,
    max_overflow=7,
    pool_recycle=1800,
    pool_pre_ping=True,
)

# 异步会话工厂
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False
)

# Base 声明基类
class Base(DeclarativeBase):
    pass

# FastAPI 依赖注入: 获取 DB 异步会话
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

# 纯内存 Mock Redis (支持键过期、自增、自减、删除)，让本地开发完全脱离 Redis 进程
class InMemoryMockRedis:
    def __init__(self):
        self._store = {}
        self._expires = {}

    async def ping(self) -> bool:
        return True

    async def get(self, key: str) -> Optional[str]:
        if key in self._expires and time.time() > self._expires[key]:
            self._store.pop(key, None)
            self._expires.pop(key, None)
            return None
        return self._store.get(key)

    async def set(self, key: str, value, ex: Optional[int] = None, nx: bool = False):
        # nx=True 时实现 SET NX，用于跨 worker 的轻量分布式锁
        if nx and await self.get(key) is not None:
            return False
        self._store[key] = str(value)
        if ex is not None:
            self._expires[key] = time.time() + ex
        return True

    async def incr(self, key: str) -> int:
        val = int(await self.get(key) or 0) + 1
        self._store[key] = str(val)
        return val

    async def decr(self, key: str) -> int:
        val = int(await self.get(key) or 0) - 1
        self._store[key] = str(val)
        return val

    async def expire(self, key: str, seconds: int) -> bool:
        self._expires[key] = time.time() + seconds
        return True

    async def delete(self, *keys):
        for k in keys:
            self._store.pop(k, None)
            self._expires.pop(k, None)

    async def keys(self, pattern: str = "*"):
        import fnmatch
        now = time.time()
        valid_keys = [
            k for k in list(self._store.keys())
            if k not in self._expires or self._expires[k] > now
        ]
        return fnmatch.filter(valid_keys, pattern)

    async def scan_iter(self, pattern: str = "*", match: Optional[str] = None, count: int = 100):
        """与真实 Redis 的 SCAN 渐进迭代语义对齐（Mock 内存版逐个 yield）"""
        import fnmatch
        effective = match if match is not None else pattern
        for key in await self.keys(effective):
            yield key

    async def close(self):
        pass

redis_client = None

async def init_redis():
    global redis_client
    if not settings.REDIS_URL or settings.REDIS_URL.lower() in ("mock", "none", ""):
        print("[Redis] 未配置外部 Redis，启用本地零延迟内存缓存模式 (InMemoryMockRedis)")
        redis_client = InMemoryMockRedis()
        return

    try:
        import redis.asyncio as aioredis
        client = aioredis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            max_connections=20
        )
        await client.ping()
        redis_client = client
        print("[Redis] 外部 Redis 异步服务连接成功")
    except Exception as e:
        print(f"[Redis 警告] 无法连接外部 Redis ({settings.REDIS_URL}): {e}，已自动平滑切换为内置内存 Mock 模式")
        redis_client = InMemoryMockRedis()

async def close_redis():
    global redis_client
    if redis_client:
        await redis_client.close()

def get_redis():
    return redis_client


def is_mock_redis() -> bool:
    """当前是否降级为进程内内存 Redis。

    降级后各 worker 的键空间彼此独立，凡是依赖跨进程一致性的逻辑
    （会话登记、验证码、登录锁）都必须跳过强校验，否则会出现随机 401。
    """
    return isinstance(redis_client, InMemoryMockRedis)
