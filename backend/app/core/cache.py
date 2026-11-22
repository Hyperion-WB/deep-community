# -*- coding: utf-8 -*-
"""
极客社区多级与旁路缓存工具 (Redis Cache-Aside Layer)
支持 JSON 自动序列化、TTL 弹性过期控制、通配符批量主动失效 (Wildcard Invalidation)
对热点 API (首页、热榜、全站看板、公约公告) 提供毫秒级内存缓存保护
"""

import json
from typing import Any, Optional
from app.core.database import get_redis


async def get_cached_json(key: str) -> Optional[Any]:
    """从 Redis 缓存获取并自动反序列化 JSON，若未命中或发生异常安全返回 None"""
    redis = get_redis()
    if not redis:
        return None
    try:
        val = await redis.get(key)
        if val:
            return json.loads(val)
    except Exception as e:
        # 缓存故障降级走数据库直查，保证高可用
        pass
    return None


async def set_cached_json(key: str, data: Any, ttl: int = 60) -> bool:
    """将数据序列化为 JSON 并存入 Redis，带自动过期时间 (默认 60 秒)"""
    redis = get_redis()
    if not redis:
        return False
    try:
        val = json.dumps(data, ensure_ascii=False)
        await redis.set(key, val, ex=ttl)
        return True
    except Exception:
        return False


async def delete_cached_key(key: str) -> bool:
    """删除指定的单个缓存键"""
    redis = get_redis()
    if not redis:
        return False
    try:
        await redis.delete(key)
        return True
    except Exception:
        return False


async def invalidate_cache_pattern(pattern: str) -> int:
    """
    根据通配符批量清理匹配的缓存键 (如 'cache:posts:*')
    常用于写操作 (发帖、点赞、删帖) 后的主动缓存失效
    """
    redis = get_redis()
    if not redis:
        return 0
    try:
        # 使用 SCAN 渐进式扫描代替 KEYS：KEYS 是 O(N) 阻塞命令，
        # 高频写路径（点赞/发帖）上会造成 Redis 全局延迟毛刺
        keys = []
        async for key in redis.scan_iter(match=pattern, count=200):
            keys.append(key)
            if len(keys) >= 500:
                break
        if keys:
            await redis.delete(*keys)
            return len(keys)
    except Exception:
        pass
    return 0


async def invalidate_posts_cache():
    """帖子变更 (新增、更新、删除、加精、置顶、点赞) 时主动清空帖子流及运行看板缓存"""
    await invalidate_cache_pattern("cache:posts:*")
    await invalidate_cache_pattern("cache:stats:*")


async def invalidate_rules_cache():
    """公约或表态签署变更时清空公约缓存"""
    await invalidate_cache_pattern("cache:rules:*")


async def invalidate_categories_cache():
    """分类变更时清空分类缓存"""
    await invalidate_cache_pattern("cache:categories:*")
