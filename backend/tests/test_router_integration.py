"""
FastAPI 路由集成与业务场景测试
Mock 数据库与外部依赖，覆盖 auth、posts、comments、users、admin 等核心路由逻辑
命名规范：方法名_场景_预期结果
"""

import uuid
from datetime import datetime, timezone, timedelta, date
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import status

from app.main import app
from app.core.database import get_db, get_redis, InMemoryMockRedis
from app.routers.deps import get_current_user, get_current_admin, get_current_super_admin
from app.core.security import create_access_token, get_password_hash
from app.models.user import User, InviteCode
from app.models.post import Post, Category
from app.models.comment import Comment
from app.models.chat import GroupRoom, GroupMember, GroupMessage


@pytest.fixture
def mock_redis():
    return InMemoryMockRedis()


@pytest.fixture
def mock_user():
    return User(
        id=uuid.uuid4(),
        username="normal_user",
        email="normal@test.com",
        password_hash=get_password_hash("password123"),
        status="active",
        role="user",
        level=2,
        experience=120,
        active_days=10,
        dnd_enabled=False,
        hide_following=False,
        hide_followers=False,
        hide_favorites=False
    )


@pytest.fixture
def mock_probation_user():
    return User(
        id=uuid.uuid4(),
        username="prob_user",
        email="prob@test.com",
        password_hash=get_password_hash("password123"),
        status="probation",
        role="user",
        level=0,
        experience=0,
        active_days=1,
        dnd_enabled=False
    )


@pytest.fixture
def mock_admin_user():
    return User(
        id=uuid.uuid4(),
        username="admin_user",
        email="admin@test.com",
        password_hash=get_password_hash("admin123"),
        status="active",
        role="super_admin",
        level=6,
        experience=9999,
        active_days=100
    )


# ===================================================================
# 1. 认证路由集成测试 (app/routers/auth.py)
# ===================================================================
class TestAuthRoutes:

    @pytest.mark.asyncio
    async def test_register_用户名已存在_返回400(self):
        mock_db = AsyncMock()
        # 模拟查出已存在用户
        existing_user = User(username="taken_user", email="taken@test.com")
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = existing_user
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/auth/register", json={
                    "username": "taken_user",
                    "email": "unique@test.com",
                    "password": "Password123!"
                })
            assert resp.status_code == status.HTTP_400_BAD_REQUEST
            assert "已被注册" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_register_无效邀请码_返回400(self):
        mock_db = AsyncMock()
        # 第一次查询查用户名 -> None (无重复)
        mock_res_user = MagicMock()
        mock_res_user.scalar_one_or_none.return_value = None
        # 第二次查询查邀请码 -> None (未找到或无效)
        mock_res_invite = MagicMock()
        mock_res_invite.scalar_one_or_none.return_value = None

        mock_db.execute.side_effect = [mock_res_user, mock_res_invite]

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/auth/register", json={
                    "username": "new_user",
                    "email": "new@test.com",
                    "password": "Password123!",
                    "invite_code": "INVALID_CODE"
                })
            assert resp.status_code == status.HTTP_400_BAD_REQUEST
            assert "邀请码无效" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_login_用户不存在_返回401(self):
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = None
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/auth/login", json={
                    "username_or_email": "non_existent",
                    "password": "Password123!"
                })
            # 凭据错误统一返回 401（此前为 400，语义不符合 HTTP 规范且便于账号探测）
            assert resp.status_code == status.HTTP_401_UNAUTHORIZED
            assert "用户名或密码错误" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_login_账号已被封禁_返回403(self):
        banned_user = User(
            id=uuid.uuid4(),
            username="banned_user",
            email="banned@test.com",
            password_hash=get_password_hash("Password123!"),
            status="banned",
            role="user"
        )
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = banned_user
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/auth/login", json={
                    "username_or_email": "banned_user",
                    "password": "Password123!"
                })
            assert resp.status_code == status.HTTP_403_FORBIDDEN
            assert "已被封禁" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_refresh_token_类型错误_返回401(self):
        # 传入 access token 冒充 refresh token
        access_tok = create_access_token(str(uuid.uuid4()), role="user")
        mock_db = AsyncMock()

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/auth/refresh", json={
                    "refresh_token": access_tok
                })
            assert resp.status_code == status.HTTP_401_UNAUTHORIZED
        finally:
            app.dependency_overrides.clear()


# ===================================================================
# 2. 帖子路由集成测试 (app/routers/posts.py)
# ===================================================================
class TestPostRoutes:

    @pytest.mark.asyncio
    async def test_create_post_见习用户发帖_返回403(self, mock_probation_user):
        mock_db = AsyncMock()
        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_probation_user

        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/posts", json={
                    "title": "测试文章标题",
                    "content_md": "这是见习用户的测试正文内容"
                })
            assert resp.status_code == status.HTTP_403_FORBIDDEN
            assert "见习观察期" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_create_post_包含敏感词标题_返回400(self, mock_user):
        mock_db = AsyncMock()
        # mock 冷却时间检查（无历史发帖）
        mock_res_cooldown = MagicMock()
        mock_res_cooldown.scalar_one_or_none.return_value = None
        mock_db.execute.return_value = mock_res_cooldown

        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_user

        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/posts", json={
                    "title": "最新赌博平台上线啦",
                    "content_md": "这是一篇正常的正文测试"
                })
            assert resp.status_code == status.HTTP_400_BAD_REQUEST
            assert "违规内容" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_batch_post_status_有效与无效ID_正确映射(self):
        p1_id = uuid.uuid4()
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.all.return_value = [(p1_id, "published", uuid.uuid4())]
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/posts/batch-status", json={
                    "post_ids": [str(p1_id), str(uuid.uuid4())]
                })
            assert resp.status_code == status.HTTP_200_OK
            data = resp.json()
            assert data[str(p1_id)] == "published"
        finally:
            app.dependency_overrides.clear()


# ===================================================================
# 3. 评论路由集成测试 (app/routers/comments.py)
# ===================================================================
class TestCommentRoutes:

    @pytest.mark.asyncio
    async def test_create_comment_帖子不存在_返回404(self, mock_user):
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = None
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_user
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/comments", json={
                    "post_id": str(uuid.uuid4()),
                    "content": "评论内容"
                })
            assert resp.status_code == status.HTTP_404_NOT_FOUND
            assert "帖子不存在" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_create_comment_关闭评论区_返回403(self, mock_user):
        closed_post = Post(
            id=uuid.uuid4(),
            author_id=uuid.uuid4(),
            title="关闭评论的文章",
            comment_policy="closed",
            status="published"
        )
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = closed_post
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_user
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/comments", json={
                    "post_id": str(closed_post.id),
                    "content": "尝试发评"
                })
            assert resp.status_code == status.HTTP_403_FORBIDDEN
            assert "已关闭评论区" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()

    @pytest.mark.asyncio
    async def test_create_comment_仅限会员评论_见习用户拦截403(self, mock_probation_user):
        member_only_post = Post(
            id=uuid.uuid4(),
            author_id=uuid.uuid4(),
            title="会员限定文章",
            comment_policy="member_only",
            status="published"
        )
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalar_one_or_none.return_value = member_only_post
        mock_db.execute.return_value = mock_res

        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_probation_user
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post("/api/comments", json={
                    "post_id": str(member_only_post.id),
                    "content": "见习用户发表评论"
                })
            assert resp.status_code == status.HTTP_403_FORBIDDEN
            assert "仅允许正式会员" in resp.json()["detail"]
        finally:
            app.dependency_overrides.clear()


# ===================================================================
# 4. 健康检查与系统配置 (app/main.py)
# ===================================================================
class TestSystemRoutes:

    @pytest.mark.asyncio
    async def test_health_check_探针可用_返回healthy(self):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.get("/api/healthz")
        assert resp.status_code == status.HTTP_200_OK
        data = resp.json()
        assert data["status"] == "healthy"
        assert "version" in data


# ===================================================================
# 5. 群聊路由与自愈逻辑 (app/routers/chat.py)
# ===================================================================
class TestChatRoutes:

    @pytest.mark.asyncio
    async def test_send_group_message_创建者发言_成功(self, mock_user):
        room_id = uuid.uuid4()
        test_room = GroupRoom(
            id=room_id,
            name="极客研讨群",
            description="讨论并发技术",
            creator_id=mock_user.id,
            is_public=False,
            announcement="",
            announcement_updated_at=None,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc)
        )
        mock_db = AsyncMock()

        async def mock_execute(stmt):
            mock_res = MagicMock()
            sql_str = str(stmt).lower()
            if "select group_rooms.creator_id" in sql_str:
                mock_res.scalar_one_or_none.return_value = mock_user.id
            elif "from group_rooms" in sql_str:
                mock_res.scalar_one_or_none.return_value = test_room
            elif "from group_members" in sql_str and "user_id" in sql_str:
                mock_res.scalars.return_value.all.return_value = [mock_user.id]
                mock_res.scalar_one_or_none.return_value = None
            else:
                mock_res.scalar_one_or_none.return_value = None
                mock_res.scalars.return_value.all.return_value = []
            return mock_res

        mock_db.execute.side_effect = mock_execute

        app.dependency_overrides[get_db] = lambda: mock_db
        app.dependency_overrides[get_current_user] = lambda: mock_user
        from app.routers.deps import get_current_active_user
        app.dependency_overrides[get_current_active_user] = lambda: mock_user
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.post(f"/api/chat/groups/{room_id}/messages", json={
                    "content": "大家好，这是第一条测试消息"
                })
            assert resp.status_code == status.HTTP_200_OK
            data = resp.json()
            assert data["content"] == "大家好，这是第一条测试消息"
            assert data["room_id"] == str(room_id)
        finally:
            app.dependency_overrides.clear()
