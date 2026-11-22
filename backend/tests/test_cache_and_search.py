# -*- coding: utf-8 -*-
"""
多级缓存与全文检索优化集成测试
测试重点：
1. 首页文章列表缓存 (cache:posts:*) 命中与主动失效
2. 运行大盘看板缓存 (cache:stats:*) 命中
3. 分类列表缓存 (cache:categories:*) 命中
4. 全文检索多关键词筛选
"""

import uuid
from unittest.mock import AsyncMock, MagicMock
import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import status

from app.main import app
from app.core.database import get_db, get_redis, InMemoryMockRedis
from app.core.cache import (
    get_cached_json,
    set_cached_json,
    invalidate_posts_cache,
    invalidate_cache_pattern,
)
from app.models.user import User


@pytest.fixture
def mock_redis():
    return InMemoryMockRedis()


@pytest.mark.anyio
async def test_cache_helpers_basic(mock_redis):
    """测试缓存工具函数 set, get, wildcard invalidate"""
    from app.core import database
    database.redis_client = mock_redis

    await set_cached_json("cache:posts:test1", {"msg": "hello"}, ttl=60)
    await set_cached_json("cache:posts:test2", {"msg": "world"}, ttl=60)
    await set_cached_json("cache:stats:test3", {"msg": "geek"}, ttl=60)

    val1 = await get_cached_json("cache:posts:test1")
    assert val1 == {"msg": "hello"}

    # 测试通配符批量清理
    cleared = await invalidate_cache_pattern("cache:posts:*")
    assert cleared == 2

    # 验证已清除
    assert await get_cached_json("cache:posts:test1") is None
    assert await get_cached_json("cache:posts:test2") is None
    # 未匹配到的不受影响
    assert await get_cached_json("cache:stats:test3") == {"msg": "geek"}


@pytest.mark.anyio
async def test_list_posts_cached_response(mock_redis):
    """测试 GET /api/posts 优先命中 Redis 旁路缓存"""
    from app.core import database
    database.redis_client = mock_redis

    # 预先在 Redis 中置入缓存数据
    fake_post_id = str(uuid.uuid4())
    fake_posts = [
        {
            "id": fake_post_id,
            "title": "缓存加速文章",
            "post_type": "post",
            "status": "published",
            "is_pinned": False,
            "is_essence": False,
            "view_count": 10,
            "like_count": 5,
            "comment_count": 2,
            "created_at": "2026-10-22T08:00:00Z",
            "reading_time_minutes": 1,
            "author_id": str(uuid.uuid4()),
            "author_username": "cached_author",
            "author_nickname": "极客加速",
            "author_avatar": "",
            "author_level": 3,
            "category_id": 1,
            "category_name": "科技前沿",
            "tags": ["缓存", "性能"],
            "poll_id": None
        }
    ]
    cache_key = "cache:posts:cat_0_all_type_all_tag_none_sort_latest"
    await set_cached_json(cache_key, fake_posts, ttl=60)

    # 模拟 DB (因为命中缓存，DB 不应被执行)
    mock_db = AsyncMock()
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.get("/api/posts?page=1&sort_by=latest")

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert len(data) == 1
    assert data[0]["title"] == "缓存加速文章"
    assert data[0]["author_username"] == "cached_author"
    # DB execute 未被调用，证明 100% 旁路命中！
    assert mock_db.execute.call_count == 0


@pytest.mark.anyio
async def test_categories_cached_response(mock_redis):
    """测试 GET /api/posts/categories 命中 Redis 缓存"""
    from app.core import database
    database.redis_client = mock_redis

    fake_cats = [{"id": 1, "name": "科技前沿", "slug": "tech", "description": "前沿技术"}]
    await set_cached_json("cache:categories:all", fake_cats, ttl=3600)

    mock_db = AsyncMock()
    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.get("/api/posts/categories")

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert len(data) == 1
    assert data[0]["name"] == "科技前沿"
    assert mock_db.execute.call_count == 0
