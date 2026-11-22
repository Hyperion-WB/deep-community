"""友情链接图标抓取。

流程：抓目标站点首页 → 从 HTML 里找 <link rel="icon"> / apple-touch-icon / og:image
→ 下载图片字节 → 交给上传服务本地化存储。

安全要点（这个接口本质上是一个「由用户指定 URL 的服务器请求」，必须防 SSRF）：
- 只允许 http/https；
- 解析域名后校验 IP，拒绝回环、内网、链路本地、保留地址；
- 限制端口 80/443（或标准端口）；
- 限制响应体大小与超时，避免被大文件或慢响应拖死。
"""

import asyncio
import ipaddress
import re
import socket
from typing import List, Optional, Tuple
from urllib.parse import urljoin, urlparse

import httpx

MAX_ICON_BYTES = 512 * 1024
MAX_HTML_CHARS = 300_000
REQUEST_TIMEOUT = 6.0
MAX_REDIRECTS = 3

USER_AGENT = (
    "Mozilla/5.0 (compatible; GeekCommunityLinkBot/1.0; +https://example.com)"
)


class UnsafeUrlError(ValueError):
    """目标地址不允许访问（内网 / 非法协议等）"""


def normalize_url(raw: str) -> str:
    """补全协议并校验基本格式。"""
    url = (raw or "").strip()
    if not url:
        raise UnsafeUrlError("网址不能为空")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise UnsafeUrlError("仅支持 http/https 网址")
    if not parsed.hostname:
        raise UnsafeUrlError("网址格式不正确")
    return url


async def _assert_public_host(host: str) -> None:
    """SSRF 防护：解析出的所有 IP 都必须是公网地址。"""
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise UnsafeUrlError("域名无法解析")

    if not infos:
        raise UnsafeUrlError("域名无法解析")

    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise UnsafeUrlError("该地址不可访问")


def _extract_icon_urls(html: str, base_url: str) -> List[str]:
    """按优先级提取候选图标地址（正则解析，避免为一个字段引入 HTML 解析依赖）。"""
    candidates: List[str] = []

    link_tags = re.findall(r"<link\b[^>]*>", html, re.I)
    scored: List[Tuple[int, str]] = []
    for tag in link_tags:
        rel = re.search(r'rel\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        href = re.search(r'href\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if not (rel and href):
            continue
        rel_val = rel.group(1).lower()
        href_val = href.group(1).strip()
        if not href_val or href_val.startswith("data:"):
            continue
        if "apple-touch-icon" in rel_val:
            score = 90
        elif "icon" in rel_val:
            score = 100 if "shortcut" in rel_val or rel_val.strip() == "icon" else 80
        else:
            continue
        # 优先大尺寸，避免抓到 16x16 的模糊图标
        if "32" in href_val or "64" in href_val or "192" in href_val:
            score += 5
        scored.append((score, urljoin(base_url, href_val)))

    scored.sort(key=lambda x: -x[0])
    candidates.extend([u for _, u in scored])

    og = re.search(
        r'<meta[^>]+property\s*=\s*["\']og:image["\'][^>]+content\s*=\s*["\']([^"\']+)["\']',
        html,
        re.I,
    )
    if og and not og.group(1).startswith("data:"):
        candidates.append(urljoin(base_url, og.group(1)))

    # 兜底：站点根 favicon
    parsed = urlparse(base_url)
    candidates.append(f"{parsed.scheme}://{parsed.netloc}/favicon.ico")

    # 去重且保序
    seen = set()
    ordered = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


async def _download_image(client: httpx.AsyncClient, url: str) -> Optional[bytes]:
    """下载候选图片，返回字节；不符要求则返回 None。"""
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
            return None
        await _assert_public_host(parsed.hostname)

        async with client.stream("GET", url) as resp:
            if resp.status_code >= 400:
                return None
            ctype = (resp.headers.get("content-type") or "").lower()
            # 有些站点 favicon 返回 application/octet-stream，靠后续魔数校验兜底
            if ctype and not (
                ctype.startswith("image/") or "octet-stream" in ctype or "icon" in ctype
            ):
                return None

            chunks = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > MAX_ICON_BYTES:
                    return None
                chunks.append(chunk)
            data = b"".join(chunks)
            if len(data) < 16:
                return None
            return data
    except Exception:
        return None


async def fetch_site_icon(site_url: str) -> Optional[bytes]:
    """抓取目标站点的图标，返回图片字节（失败返回 None）。

    调用方负责把它存成本地文件并写回 icon_url。
    """
    url = normalize_url(site_url)
    host = urlparse(url).hostname
    if not host:
        raise UnsafeUrlError("网址格式不正确")
    await _assert_public_host(host)

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
    }
    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT,
        follow_redirects=True,
        max_redirects=MAX_REDIRECTS,
        headers=headers,
    ) as client:
        html = ""
        base = url
        try:
            resp = await client.get(url)
            ctype = (resp.headers.get("content-type") or "").lower()
            if "html" in ctype or not ctype:
                html = resp.text[:MAX_HTML_CHARS]
            if resp.url:
                base = str(resp.url)
        except Exception:
            html = ""
        candidates = _extract_icon_urls(html, base) if html else [urljoin(url, "/favicon.ico")]

        for candidate in candidates[:6]:
            data = await _download_image(client, candidate)
            if data:
                return data
    return None
