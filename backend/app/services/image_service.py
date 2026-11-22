import io
import os
import re
import time
import uuid
import asyncio
from contextlib import closing
from datetime import datetime
from urllib.parse import urlsplit
from PIL import Image, ImageOps, ImageSequence
from fastapi import UploadFile, HTTPException
from app.core.config import settings

# 允许的标准图片 MIME 类型
ALLOWED_MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_FILE_BYTES = settings.MAX_IMAGE_SIZE_MB * 1024 * 1024
MAX_GIF_BYTES = settings.MAX_GIF_SIZE_MB * 1024 * 1024
# 读取阶段的上限（真实格式未知前按两者较大者兜底，读完再按格式精判）
READ_LIMIT_BYTES = max(MAX_FILE_BYTES, MAX_GIF_BYTES)
# 超过这个体积的动图会做「缩尺寸 + 抽帧」瘦身（几 MB、上百帧的 GIF 在列表里解码很吃力）
GIF_OPTIMIZE_MIN_BYTES = 2 * 1024 * 1024


def optimize_animated_gif(data: bytes, max_side: int = 320, max_frames: int = 60) -> bytes:
    """给大动图瘦身：等比缩到 max_side 内、按比例抽帧，保留动画与原循环。

    只做「变小」不做「变静」：体积没有下降就原样返回；任何异常都回退原图，
    绝不让动图优化影响上传成功率。
    """
    try:
        with Image.open(io.BytesIO(data)) as im:
            total = int(getattr(im, "n_frames", 1) or 1)
            if total <= 1:
                return data
            step = max(1, -(-total // max_frames))  # 向上取整，保证不超过 max_frames
            frames: list = []
            duration = 80
            for idx, frame in enumerate(ImageSequence.Iterator(im)):
                if idx % step:
                    continue
                if idx == 0:
                    duration = int(frame.info.get("duration") or 80)
                rgba = frame.convert("RGBA")
                if max(rgba.size) > max_side:
                    ratio = max_side / max(rgba.size)
                    rgba = rgba.resize(
                        (max(1, int(rgba.width * ratio)), max(1, int(rgba.height * ratio))),
                        Image.Resampling.LANCZOS,
                    )
                frames.append(rgba)
            if not frames:
                return data
            out = io.BytesIO()
            frames[0].save(
                out, format="GIF", save_all=True, append_images=frames[1:],
                duration=max(20, duration * step), loop=0, optimize=True, disposal=2,
            )
            optimized = out.getvalue()
            return optimized if len(optimized) < len(data) else data
    except Exception as exc:
        print(f"[Image] 动图瘦身失败，保留原图: {exc}")
        return data


def validate_image_header(file_bytes: bytes) -> str:
    """通过 Pillow 检测文件真实图像格式 (防伪造扩展名注入)"""
    try:
        with Image.open(io.BytesIO(file_bytes)) as img:
            format_name = img.format.lower() if img.format else ""
            if format_name in ["jpeg", "jpg"]:
                return "image/jpeg"
            elif format_name == "png":
                return "image/png"
            elif format_name == "webp":
                return "image/webp"
            elif format_name == "gif":
                return "image/gif"
            else:
                raise ValueError("不支持的图片格式")
    except Exception:
        raise HTTPException(status_code=400, detail="上传的文件不是有效的图像文件")


def process_and_compress_image(
    file_bytes: bytes,
    max_width: int = 1920,
    max_height: int = 1920,
    quality: int = 80,
    is_avatar: bool = False
) -> bytes:
    """
    高保真视觉无损图片处理与压缩流水线:
    1. 保持动图 GIF 原貌，不破坏动态帧
    2. 依据 EXIF 元数据自动校正手机拍摄旋转角度 (exif_transpose)
    3. 保留 RGBA 透明通道 (解决透明 PNG 变黑底问题)
    4. 内存友好：零内存解包，彻底避免 140MB 物理内存限制下的 OOM 宕机
    5. 尺寸优化：帖子图等比缩放至 1920 以内，头像智能居中适配为 512x512 方图
    6. 转码 WebP (method=6 高压缩率深度计算，quality=82 视觉无损高保真，体积缩减 70%~85%)
    """
    started = time.perf_counter()
    original_size = len(file_bytes)

    with Image.open(io.BytesIO(file_bytes)) as img:
        # 动图 GIF：保留动画不转码；但几 MB / 上百帧的大动图渲染很吃力，
        # 超过阈值时先缩尺寸 + 抽帧（仍是 GIF、仍会动），小动图原样返回
        if img.format == "GIF":
            if len(file_bytes) > GIF_OPTIMIZE_MIN_BYTES:
                return optimize_animated_gif(file_bytes)
            return file_bytes
        if getattr(img, "is_animated", False):
            return file_bytes

        # JPEG 先用 draft 让解码器直接按目标尺寸解码（大图可快 2~3 倍）
        if img.format == "JPEG":
            try:
                img.draft("RGB", (max_width, max_height))
            except Exception:
                pass

        # 仅在存在非标准 EXIF 方向时才旋转，避免每张图都走一次像素级变换
        try:
            orientation = (img.getexif() or {}).get(274)
        except Exception:
            orientation = None
        if orientation and orientation != 1:
            img = ImageOps.exif_transpose(img)

        # 模式归一化: 保留透明通道，其余统一 RGB
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        # 尺寸处理：先缩放到目标尺寸再编码，减少编码阶段的像素量
        if is_avatar:
            img = ImageOps.fit(img, (512, 512), Image.Resampling.LANCZOS)
        else:
            img.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)

        # method=4 相比 method=6 编码快约 2~3 倍，体积仅增加几个百分点；
        # optimize=True 会额外做多轮熵优化，首图上传体感明显更慢，这里关闭。
        output = io.BytesIO()
        img.save(output, format="WEBP", quality=quality, method=4, optimize=False)
        data = output.getvalue()

    elapsed_ms = (time.perf_counter() - started) * 1000
    print(
        f"[Image] {original_size // 1024}KB -> {len(data) // 1024}KB "
        f"in {elapsed_ms:.0f}ms (avatar={is_avatar})"
    )
    return data


def _encode_compatible_preview(source) -> bytes | None:
    try:
        with Image.open(source, formats=["WEBP", "PNG", "GIF"]) as img:
            if img.width * img.height > 16_000_000:
                return None
            img.thumbnail((512, 512))
            with io.BytesIO() as output:
                img.convert("RGBA").save(output, format="PNG")
                return output.getvalue()
    except (OSError, ValueError, Image.DecompressionBombError):
        return None


def _s3_upload_bases() -> tuple[str, ...]:
    bases = [settings.S3_PUBLIC_DOMAIN]
    if settings.S3_ENDPOINT and settings.S3_BUCKET:
        bases.append(f"{settings.S3_ENDPOINT.rstrip('/')}/{settings.S3_BUCKET}")
    return tuple(base.rstrip("/") for base in bases if base)


def _storage_url_parts(url: str) -> tuple[str, str, int, str] | None:
    try:
        parsed = urlsplit(url)
        if parsed.scheme in ("https", "http") and parsed.hostname and not (
            parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
        ):
            port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
            return parsed.scheme, parsed.hostname, port, parsed.path
    except ValueError:
        pass
    return None


def get_compatible_upload_preview(path: str, source_url: str | None = None) -> bytes | None:
    """从本地或配置的对象存储生成上传图的 PNG 首帧。"""
    if not re.fullmatch(r"(?:stickers|[0-9]{4}/[0-9]{2})/[a-f0-9]{32}\.(?:webp|png|gif)", path):
        return None

    key = f"uploads/{path}"
    if source_url is not None:
        # URL 仅用来核对归属，读取始终使用固定的存储配置与已校验的对象 key。
        source = _storage_url_parts(source_url)
        if source is None or not any(source == _storage_url_parts(f"{base}/{key}") for base in _s3_upload_bases()):
            return None

    preview = _encode_compatible_preview(os.path.join(settings.UPLOAD_DIR, path))
    if preview is not None:
        return preview

    if (settings.STORAGE_TYPE or "").lower() != "s3" and not is_mirror_enabled():
        return None
    client = get_s3_client()
    if client is None:
        return None
    try:
        response = client.get_object(Bucket=settings.S3_BUCKET, Key=key)
        with closing(response["Body"]) as body:
            if response.get("ContentLength", 0) > READ_LIMIT_BYTES:
                return None
            data = body.read(READ_LIMIT_BYTES + 1)
        if len(data) <= READ_LIMIT_BYTES:
            return _encode_compatible_preview(io.BytesIO(data))
    except Exception as exc:
        # 首帧是降级资源，镜像对象缺失或存储异常时由调用方显示占位。
        print(f"[Storage] 图片兼容预览读取失败 key={key}: {exc}")
    return None


def get_s3_client():
    """获取并配置兼容 Cloudflare R2 / AWS S3 的客户端 (严格遵循 S3v4 签名标准)"""
    # 总开关关闭时直接返回，配置缺失也不会产生任何上传请求
    if not settings.S3_ENABLED:
        return None
    if not settings.S3_ENDPOINT or not settings.S3_ACCESS_KEY or not settings.S3_SECRET_KEY or not settings.S3_BUCKET:
        return None
    try:
        import boto3
        from botocore.config import Config

        return boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION or "auto",
            config=Config(
                signature_version="s3v4",
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=5,
                read_timeout=15,
            )
        )
    except Exception as e:
        print(f"[Storage 错误] 初始化 S3/R2 客户端失败: {e}")
        return None


def sync_upload_bytes_to_s3(client, bucket: str, key: str, data: bytes, content_type: str = "image/webp") -> bool:
    """同步上传二进制流至 S3/R2 存储桶 (设置 1 年强缓存 Cache-Control)"""
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
        CacheControl="public, max-age=31536000, immutable"
    )
    return True


def test_s3_connection() -> dict:
    """连通性诊断：测试 Cloudflare R2 / S3 凭据有效性与读写延迟"""
    import time
    is_s3_enabled = (settings.STORAGE_TYPE or "").lower() == "s3"

    if not settings.S3_ENABLED:
        return {
            "success": False,
            "is_s3": False,
            "enabled": False,
            "message": "对象存储已停用（S3_ENABLED=false），当前仅使用本地磁盘存储与本地备份",
            "latency_ms": 0
        }

    client = get_s3_client()
    if not client:
        return {
            "success": False,
            "is_s3": is_s3_enabled,
            "enabled": True,
            "message": "尚未配置完整的 S3/R2 凭证 (需在 .env 中配置 S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET)",
            "latency_ms": 0
        }

    t0 = time.time()
    try:
        client.head_bucket(Bucket=settings.S3_BUCKET)
        latency = round((time.time() - t0) * 1000, 2)
        active_str = "已作为当前主力存储生效" if is_s3_enabled else "连通正常，当前系统保留为本地存储模式 (切换 STORAGE_TYPE=s3 即可启用)"
        return {
            "success": True,
            "is_s3": is_s3_enabled,
            "message": f"连接正常！存储桶 [{settings.S3_BUCKET}] 连通性测试通过 ({active_str})",
            "latency_ms": latency
        }
    except Exception as e:
        latency = round((time.time() - t0) * 1000, 2)
        err_msg = str(e)
        if "403" in err_msg or "Forbidden" in err_msg:
            err_msg = "认证失败 (403 Forbidden)：AccessKey 或 SecretKey 无权访问该存储桶"
        elif "404" in err_msg or "NotFound" in err_msg:
            err_msg = f"存储桶未找到 (404 Not Found)：请检查存储桶名称 [{settings.S3_BUCKET}] 是否正确"
        return {
            "success": False,
            "is_s3": True,
            "message": err_msg,
            "latency_ms": latency
        }


# 后台镜像任务的强引用集合，避免 asyncio 任务被 GC 提前回收
_MIRROR_TASKS: set = set()


def is_mirror_enabled() -> bool:
    """镜像双写模式：本地为主存储，对象存储做备份与回源。

    仅当 STORAGE_TYPE=local 且显式打开 S3_MIRROR、且 S3 凭证完整时生效；
    任何一项缺失都自动退化为纯本地模式，不影响上传。
    """
    if not settings.S3_ENABLED:
        return False
    if (settings.STORAGE_TYPE or "").lower() != "local" or not settings.S3_MIRROR:
        return False
    # 占位符（.env.example 里的 your_xxx / <xxx>）视为未配置，避免每张图都刷鉴权失败日志
    placeholders = ("your_", "<your", "your-")
    values = [
        settings.S3_ENDPOINT or "",
        settings.S3_ACCESS_KEY or "",
        settings.S3_SECRET_KEY or "",
        settings.S3_BUCKET or "",
    ]
    if any(not v or v.lower().startswith(placeholders) for v in values):
        return False
    return True


async def _mirror_upload(object_key: str, data: bytes, content_type: str = "image/webp") -> None:
    """后台把本地已落盘的图片补传对象存储，失败重试 3 次（指数退避）。"""
    client = get_s3_client()
    if not client:
        return
    for attempt in range(1, 4):
        try:
            await asyncio.to_thread(
                sync_upload_bytes_to_s3,
                client, settings.S3_BUCKET, object_key, data, content_type
            )
            # 立即路径成功后把持久队列里的这条也摘掉，避免定时任务重复上传
            try:
                from app.services.storage_sync import _dequeue

                await _dequeue(object_key, content_type)
            except Exception:
                pass
            return
        except Exception as e:
            if attempt >= 3:
                print(f"[Storage 警告] 镜像上传失败(已重试3次) key={object_key}: {e}")
                return
            await asyncio.sleep(attempt * 2)


def _schedule_mirror_upload(object_key: str, data: bytes, content_type: str = "image/webp") -> None:
    """异步投递镜像任务，绝不阻塞用户上传请求。"""
    try:
        task = asyncio.create_task(_mirror_upload(object_key, data, content_type))
    except RuntimeError:
        return
    _MIRROR_TASKS.add(task)
    task.add_done_callback(_MIRROR_TASKS.discard)


def _storage_key(storage_path: str) -> str:
    """把数据库里的相对路径或完整 URL 归一化为对象 key（uploads/YYYY/MM/x.webp）。"""
    if not storage_path:
        return ""
    if storage_path.startswith("/"):
        return storage_path.lstrip("/")
    idx = storage_path.find("uploads/")
    return storage_path[idx:] if idx != -1 else ""


def delete_stored_image(storage_path: str) -> dict:
    """删除一张图片：本地文件与对象存储对象**两边都尝试**。

    孤儿清理统一走这里，保证「本地删掉的同时对象存储也删掉」，
    任一侧失败只记录日志、不阻断另一侧。
    """
    result = {"local": False, "s3": False}
    key = _storage_key(storage_path)
    if not key.startswith("uploads/"):
        return result

    # 1) 本地文件
    full_path = os.path.join(settings.UPLOAD_DIR, key[len("uploads/"):])
    try:
        if os.path.exists(full_path):
            os.remove(full_path)
        result["local"] = True
    except Exception as e:
        print(f"[Storage 警告] 本地文件删除失败 {full_path}: {e}")

    # 2) 对象存储（镜像模式或纯 S3 模式）
    #    先复制到 trash/ 回收站再删原对象，30 天内可捞回，避免误删不可恢复
    if is_mirror_enabled() or (settings.STORAGE_TYPE or "").lower() == "s3":
        client = get_s3_client()
        if client:
            trash_key = f"trash/{key}"
            try:
                client.copy_object(
                    Bucket=settings.S3_BUCKET,
                    Key=trash_key,
                    CopySource={"Bucket": settings.S3_BUCKET, "Key": key},
                )
                result["trashed"] = True
            except Exception as e:
                # 原对象可能已不存在，继续尝试删除流程
                print(f"[Storage 警告] 回收站备份失败 key={key}: {e}")
            try:
                client.delete_object(Bucket=settings.S3_BUCKET, Key=key)
                result["s3"] = True
            except Exception as e:
                print(f"[Storage 警告] 对象存储删除失败 key={key}: {e}")
    return result


async def save_upload_image(file: UploadFile, uploader_id: str, is_avatar: bool = False) -> tuple[str, int]:
    """
    读取、校验、压缩并存储图片:
    1. 静态图自动 WebP 压缩转码；动图 GIF 原样保留（不转码、不失帧）；
    2. 分块读取，超过上限立刻中断，避免超大文件一次性占满进程内存；
    3. 当前仅落本地磁盘，对象存储总开关关闭时不会产生任何外网上传。
    返回 (url, file_size)
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > READ_LIMIT_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"文件过大，动图最大 {settings.MAX_GIF_SIZE_MB}MB、静态图最大 {settings.MAX_IMAGE_SIZE_MB}MB",
            )
        chunks.append(chunk)
    content = b"".join(chunks)

    mime = validate_image_header(content)
    limit_bytes = MAX_GIF_BYTES if mime == "image/gif" else MAX_FILE_BYTES
    if len(content) > limit_bytes:
        tip = (
            f"动图最大 {settings.MAX_GIF_SIZE_MB}MB"
            if mime == "image/gif"
            else f"图片最大 {settings.MAX_IMAGE_SIZE_MB}MB"
        )
        raise HTTPException(status_code=413, detail=f"文件超过限制（{tip}），请压缩后再试")

    import asyncio
    # Pillow 解码/缩放是纯 CPU 操作，放到线程池避免阻塞事件循环（单 worker 下尤其关键）
    compressed_bytes = await asyncio.to_thread(process_and_compress_image, content, is_avatar=is_avatar)

    from app.core.timezone import utc_now
    now = utc_now()
    year_month = now.strftime("%Y/%m")
    # 动图可能保留 GIF、APNG 或 WebP，静态图通常转为 WebP。
    content_type = validate_image_header(compressed_bytes)
    ext = content_type.split("/", 1)[1]
    filename = f"{uuid.uuid4().hex}.{ext}"
    object_key = f"uploads/{year_month}/{filename}"

    # 优先检测是否启用了 S3 / Cloudflare R2 对象存储（总开关默认关闭）
    is_s3_mode = settings.S3_ENABLED and (settings.STORAGE_TYPE or "").lower() == "s3"
    s3_uploaded = False

    if is_s3_mode:
        client = get_s3_client()
        if client:
            try:
                await asyncio.to_thread(
                    sync_upload_bytes_to_s3,
                    client,
                    settings.S3_BUCKET,
                    object_key,
                    compressed_bytes,
                    content_type
                )
                s3_uploaded = True
            except Exception as s3_err:
                print(f"[Storage 警告] Cloudflare R2 / S3 上传异常: {s3_err}，已平滑降级至本地磁盘存储")

    if s3_uploaded:
        return f"{_s3_upload_bases()[0]}/{object_key}", len(compressed_bytes)

    # 本地磁盘存储路径 (默认或降级兜底)
    rel_dir = os.path.join(settings.UPLOAD_DIR, year_month)
    os.makedirs(rel_dir, exist_ok=True)
    file_path = os.path.join(rel_dir, filename)

    with open(file_path, "wb") as f:
        f.write(compressed_bytes)

    relative_url = f"/uploads/{year_month}/{filename}".replace("\\", "/")

    # 镜像模式下，本地写盘成功后再异步补传对象存储（不拖慢用户上传）
    if is_mirror_enabled():
        # 先登记到持久队列（一次 Redis SADD，亚毫秒级），再由后台 task 立刻尝试。
        # 好处：进程重启/发布不会让这批图永远留在本地没有备份；
        # 定时任务会把积压的补传完。
        try:
            from app.services.storage_sync import enqueue_mirror

            await enqueue_mirror(object_key, content_type)
        except Exception:
            pass
        _schedule_mirror_upload(object_key, compressed_bytes, content_type)

    return relative_url, len(compressed_bytes)
