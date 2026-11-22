"""外链图片代理 + 缩放。

首页/列表里的封面图常常直接指向外部站点的原图（实测单张 890KB），
在移动端非常拖累首屏与滚动。这里统一代理并按需缩放成 webp 缓存，
既省流量又避免第三方站点慢导致页面卡住。

安全：
- 只允许 http/https，端口限 80/443
- 解析域名后拒绝内网/保留地址（防 SSRF）
- 下载上限 8MB、超时 8 秒
"""
import asyncio
import hashlib
import ipaddress
import socket
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from PIL import Image

router = APIRouter(prefix="/media", tags=["媒体"])

CACHE_DIR = Path("/app/uploads/proxy")
MAX_BYTES = 8 * 1024 * 1024
TIMEOUT = 8.0
UA = "Mozilla/5.0 (compatible; community-image-proxy/1.0)"


def _is_private_host(host: str) -> bool:
    """域名解析出的任一地址是内网/保留地址就拒绝。"""
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return True
    for info in infos:
        raw = info[4][0]
        try:
            ip = ipaddress.ip_address(raw)
        except ValueError:
            return True
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or (ip.version == 6 and ip.ipv4_mapped and ip.ipv4_mapped.is_private)
        ):
            return True
    return False


@router.get("/proxy")
async def proxy_image(
    url: str = Query(..., max_length=1200),
    w: int = Query(640, ge=64, le=1600),
):
    """把外链图片缩放为 webp 并缓存；失败时 404，让前端回退原图。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="仅支持 http/https 图片")
    if parsed.port not in (None, 80, 443):
        raise HTTPException(status_code=400, detail="端口不允许")
    host = parsed.hostname or ""
    if not host:
        raise HTTPException(status_code=400, detail="地址无效")
    if await asyncio.to_thread(_is_private_host, host):
        raise HTTPException(status_code=400, detail="地址不允许")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{url}|{w}".encode("utf-8")).hexdigest()[:24]
    out_path = CACHE_DIR / f"{key}_{w}.webp"
    if out_path.exists():
        return FileResponse(out_path, media_type="image/webp", headers={
            "Cache-Control": "public, max-age=2592000, immutable",
        })

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            async with client.stream("GET", url, headers={"User-Agent": UA}) as resp:
                if resp.status_code != 200:
                    raise HTTPException(status_code=404, detail="源图不可用")
                buf = bytearray()
                async for chunk in resp.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > MAX_BYTES:
                        raise HTTPException(status_code=413, detail="图片过大")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail="源图拉取失败")

    def _encode() -> None:
        import io
        with Image.open(io.BytesIO(bytes(buf))) as img:
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            img.thumbnail((w, w * 4), Image.Resampling.LANCZOS)
            img.save(out_path, format="WEBP", quality=82, method=4)

    try:
        await asyncio.to_thread(_encode)
    except Exception:
        raise HTTPException(status_code=415, detail="不是可处理的图片")

    return FileResponse(out_path, media_type="image/webp", headers={
        "Cache-Control": "public, max-age=2592000, immutable",
    })
