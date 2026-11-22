import io
import uuid
import pytest
from unittest.mock import MagicMock, patch
from PIL import Image
from fastapi import UploadFile
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.core.config import settings
from app.core.database import get_db, get_redis, InMemoryMockRedis
from app.routers.deps import get_current_root_admin
from app.models.user import User
from app.models.post import Post, PostImage
from app.services.image_service import (
    validate_image_header,
    process_and_compress_image,
    get_s3_client,
    test_s3_connection as check_s3_connection,
    save_upload_image,
)
from app.routers.posts import mark_images_attached


def create_test_image(format="JPEG", size=(100, 100), color=(255, 0, 0)) -> bytes:
    img = Image.new("RGB", size, color=color)
    buf = io.BytesIO()
    img.save(buf, format=format)
    return buf.getvalue()


@pytest.fixture
def mock_admin():
    return User(
        id=uuid.uuid4(),
        username="admin_tester",
        email="admin@test.com",
        status="active",
        role="admin",
        level=5,
        experience=999,
    )


# 1. 基础图像校验与处理测试
def test_validate_image_header_valid():
    jpg_bytes = create_test_image("JPEG")
    assert validate_image_header(jpg_bytes) == "image/jpeg"

    png_bytes = create_test_image("PNG")
    assert validate_image_header(png_bytes) == "image/png"


def test_process_and_compress_image():
    raw_bytes = create_test_image("JPEG", size=(2500, 1500))
    compressed = process_and_compress_image(raw_bytes, max_width=1920, max_height=1920, is_avatar=False)
    assert len(compressed) > 0

    with Image.open(io.BytesIO(compressed)) as out:
        assert out.format == "WEBP"
        assert out.width <= 1920
        assert out.height <= 1920


def test_process_and_compress_avatar():
    raw_bytes = create_test_image("JPEG", size=(800, 600))
    compressed = process_and_compress_image(raw_bytes, is_avatar=True)
    with Image.open(io.BytesIO(compressed)) as out:
        assert out.format == "WEBP"
        assert out.size == (512, 512)


# 2. 本地存储模式测试
@pytest.mark.asyncio
async def test_save_upload_image_local_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "STORAGE_TYPE", "local")
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))

    img_bytes = create_test_image("PNG")
    upload_file = UploadFile(filename="test.png", file=io.BytesIO(img_bytes))

    url, size = await save_upload_image(upload_file, uploader_id="user1")
    assert url.startswith("/uploads/")
    assert url.endswith(".webp")
    assert size > 0


# 3. S3 / Cloudflare R2 模式与优雅降级测试
@pytest.mark.asyncio
async def test_save_upload_image_s3_success(monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_TYPE", "s3")
    monkeypatch.setattr(settings, "S3_ENDPOINT", "https://test-account.r2.cloudflarestorage.com")
    monkeypatch.setattr(settings, "S3_ACCESS_KEY", "mock_ak")
    monkeypatch.setattr(settings, "S3_SECRET_KEY", "mock_sk")
    monkeypatch.setattr(settings, "S3_BUCKET", "test-bucket")
    monkeypatch.setattr(settings, "S3_PUBLIC_DOMAIN", "https://img.community.com")

    mock_boto_client = MagicMock()
    with patch("app.services.image_service.get_s3_client", return_value=mock_boto_client), \
         patch("app.services.image_service.sync_upload_bytes_to_s3", return_value=True):

        img_bytes = create_test_image("PNG")
        upload_file = UploadFile(filename="test.png", file=io.BytesIO(img_bytes))

        url, size = await save_upload_image(upload_file, uploader_id="user1")
        assert url.startswith("https://img.community.com/uploads/")
        assert url.endswith(".webp")


@pytest.mark.asyncio
async def test_save_upload_image_s3_failure_fallback_to_local(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "STORAGE_TYPE", "s3")
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))

    mock_boto_client = MagicMock()
    with patch("app.services.image_service.get_s3_client", return_value=mock_boto_client), \
         patch("app.services.image_service.sync_upload_bytes_to_s3", side_effect=Exception("S3 Upload Timeout")):

        img_bytes = create_test_image("PNG")
        upload_file = UploadFile(filename="test.png", file=io.BytesIO(img_bytes))

        # 遇到网络异常应自动优雅降级至本地磁盘
        url, size = await save_upload_image(upload_file, uploader_id="user1")
        assert url.startswith("/uploads/")
        assert url.endswith(".webp")


# 4. 连通性诊断测试
def test_s3_connection_diagnostics(monkeypatch):
    monkeypatch.setattr(settings, "S3_ENDPOINT", None)
    diag = check_s3_connection()
    assert diag["success"] is False
    assert "尚未配置完整的 S3/R2 凭证" in diag["message"]

    monkeypatch.setattr(settings, "S3_ENDPOINT", "https://r2.test")
    monkeypatch.setattr(settings, "S3_ACCESS_KEY", "ak")
    monkeypatch.setattr(settings, "S3_SECRET_KEY", "sk")
    monkeypatch.setattr(settings, "S3_BUCKET", "bucket")

    mock_client = MagicMock()
    with patch("app.services.image_service.get_s3_client", return_value=mock_client):
        res = check_s3_connection()
        assert res["success"] is True
        assert "连通性测试通过" in res["message"]


# 5. 管理员接口测试 (屏蔽 SecretKey 泄露)
@pytest.mark.asyncio
async def test_admin_storage_status_endpoint(mock_admin):
    app.dependency_overrides[get_current_root_admin] = lambda: mock_admin
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/admin/storage/status")
        assert res.status_code == 200
        data = res.json()
        assert "storage_type" in data
        assert "has_access_key" in data
        assert "has_secret_key" in data
        # 绝不泄漏私钥具体字符串
        assert "s3_secret_key" not in data
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_admin_storage_test_endpoint(mock_admin):
    app.dependency_overrides[get_current_root_admin] = lambda: mock_admin
    with patch("app.services.image_service.test_s3_connection", return_value={"success": True, "message": "OK", "latency_ms": 12.3}):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post("/api/admin/storage/test")
            assert res.status_code == 200
            data = res.json()
            assert data["success"] is True
            assert data["latency_ms"] == 12.3
    app.dependency_overrides.clear()


# 6. mark_images_attached 双模 URL 匹配测试
@pytest.mark.asyncio
async def test_mark_images_attached_local_and_s3():
    from unittest.mock import AsyncMock
    mock_db = AsyncMock()

    post_id = uuid.uuid4()
    content = """
    这是测试内容
    ![本地图](/uploads/2026/10/local1.webp)
    ![S3图](https://pub-abc.r2.dev/uploads/2026/10/s3image.webp)
    """

    await mark_images_attached(mock_db, post_id, content)
    assert mock_db.execute.called
