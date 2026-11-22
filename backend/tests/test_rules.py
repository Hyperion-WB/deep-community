# -*- coding: utf-8 -*-
"""
社区公约与入站必读 (Rules & Endorsements) 路由测试
覆盖 GET /api/rules, PUT /api/rules, POST /api/rules/endorse, DELETE /api/rules/endorse
"""

import uuid
from unittest.mock import AsyncMock, MagicMock
import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import status

from app.main import app
from app.core.database import get_db, get_redis, InMemoryMockRedis
from app.routers.deps import get_current_user, get_current_user_optional, get_current_super_admin
from app.models.user import User
from app.models.system import CommunityRule, CommunityEndorsement


@pytest.fixture
def mock_redis():
    return InMemoryMockRedis()


@pytest.fixture
def normal_user():
    return User(
        id=uuid.uuid4(),
        username="geek_tester",
        nickname="先锋极客",
        avatar_url="/avatars/tester.png",
        status="active",
        role="user",
        level=3,
        experience=350,
        active_days=15
    )


@pytest.fixture
def super_admin_user():
    return User(
        id=uuid.uuid4(),
        username="super_admin",
        nickname="最高管理员",
        status="active",
        role="super_admin",
        level=6,
        experience=9999,
        active_days=100
    )


@pytest.mark.anyio
async def test_get_rules_public_success(mock_redis):
    """未登录公开访问获取社区公约"""
    mock_db = AsyncMock()
    fake_rule = CommunityRule(
        id=1,
        title="极客社区自治公约与入站必读规范",
        content="# 社区守则正文",
        version=1
    )
    # 模拟查询 rule, count, recent
    mock_res_rule = MagicMock()
    mock_res_rule.scalar_one_or_none.return_value = fake_rule

    mock_res_count = MagicMock()
    mock_res_count.scalar.return_value = 10

    mock_res_recent = MagicMock()
    mock_res_recent.all.return_value = []

    mock_db.execute.side_effect = [mock_res_rule, mock_res_count, mock_res_recent]

    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis
    app.dependency_overrides[get_current_user_optional] = lambda: None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.get("/api/rules")

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert data["title"] == "极客社区自治公约与入站必读规范"
    assert data["endorsements_count"] == 10
    assert data["user_endorsed"] is False


@pytest.mark.anyio
async def test_endorse_rules_success(mock_redis, normal_user):
    """登录用户签署并表态支持公约"""
    mock_db = AsyncMock()
    # 模拟未曾签署过
    mock_res_find = MagicMock()
    mock_res_find.scalar_one_or_none.return_value = None

    mock_res_count = MagicMock()
    mock_res_count.scalar.return_value = 11

    mock_db.execute.side_effect = [mock_res_find, mock_res_count]

    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis
    app.dependency_overrides[get_current_user] = lambda: normal_user

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.post("/api/rules/endorse", json={
            "stance": "pledge",
            "comment": "恪守公约，纯粹交流"
        })

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert data["success"] is True
    assert data["user_endorsed"] is True
    assert data["endorsements_count"] == 11
    assert data["endorsement"]["comment"] == "恪守公约，纯粹交流"


@pytest.mark.anyio
async def test_revoke_endorsement_success(mock_redis, normal_user):
    """用户撤回公约签署"""
    mock_db = AsyncMock()
    fake_end = CommunityEndorsement(
        id=1,
        user_id=normal_user.id,
        stance="pledge",
        comment="测试"
    )
    mock_res_find = MagicMock()
    mock_res_find.scalar_one_or_none.return_value = fake_end

    mock_res_count = MagicMock()
    mock_res_count.scalar.return_value = 10

    mock_db.execute.side_effect = [mock_res_find, mock_res_count]

    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis
    app.dependency_overrides[get_current_user] = lambda: normal_user

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.delete("/api/rules/endorse")

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert data["success"] is True
    assert data["user_endorsed"] is False
    assert data["endorsements_count"] == 10


@pytest.mark.anyio
async def test_update_rules_by_super_admin(mock_redis, super_admin_user):
    """超级管理员更新社区公约与入站必读"""
    mock_db = AsyncMock()
    fake_rule = CommunityRule(
        id=1,
        title="旧标题",
        content="旧内容",
        version=1
    )
    mock_res_find = MagicMock()
    mock_res_find.scalar_one_or_none.return_value = fake_rule

    mock_db.execute.return_value = mock_res_find

    app.dependency_overrides[get_db] = lambda: mock_db
    app.dependency_overrides[get_redis] = lambda: mock_redis
    app.dependency_overrides[get_current_super_admin] = lambda: super_admin_user

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        res = await ac.put("/api/rules", json={
            "title": "极客社区新公约",
            "content": "# 新公约完整内容..."
        })

    app.dependency_overrides.clear()

    assert res.status_code == status.HTTP_200_OK
    data = res.json()
    assert data["success"] is True
    assert data["title"] == "极客社区新公约"
    assert data["version"] == 2
