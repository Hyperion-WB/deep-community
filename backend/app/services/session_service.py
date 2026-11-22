"""登录会话（设备）管理。

会话以 refresh token 中的 sid 为准：刷新令牌轮换时 sid 不变，
因此同一台设备在列表里始终只有一行，不会因为刷新而不断新增。
"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decode_token
from app.models.user import UserSession
from app.services.ip_service import extract_client_ip

# 顺序敏感：先匹配更具体的标识
_OS_MAP = [
    ("iPhone", "iOS"),
    ("iPad", "iPadOS"),
    ("HarmonyOS", "HarmonyOS"),
    ("Android", "Android"),
    ("Windows", "Windows"),
    ("Macintosh", "macOS"),
    ("CrOS", "ChromeOS"),
    ("Linux", "Linux"),
]
_BROWSER_MAP = [
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("MicroMessenger", "微信"),
    ("Firefox/", "Firefox"),
    ("Chrome/", "Chrome"),
    ("Safari/", "Safari"),
]


def parse_device(user_agent: str) -> str:
    ua = user_agent or ""
    os_name = next((name for kw, name in _OS_MAP if kw in ua), "未知系统")
    browser = next((name for kw, name in _BROWSER_MAP if kw in ua), "未知浏览器")
    return f"{os_name} · {browser}"


def client_ip(request: Optional[Request]) -> str:
    if not request:
        return ""
    try:
        return extract_client_ip(dict(request.headers), request.client.host if request.client else "") or ""
    except Exception:
        return ""


async def get_session(db: AsyncSession, sid: str) -> Optional[UserSession]:
    if not sid:
        return None
    return (
        await db.execute(select(UserSession).where(UserSession.id == sid))
    ).scalar_one_or_none()


async def create_or_touch_session(
    db: AsyncSession,
    sid: str,
    user_id,
    request: Optional[Request],
    refresh_token: str = "",
) -> Optional[UserSession]:
    """登记会话；已存在则只刷新活跃时间（刷新令牌轮换不会新增设备）。"""
    if not sid:
        return None

    session = await get_session(db, sid)
    now = datetime.now(timezone.utc)
    if session:
        session.last_active_at = now
        return session

    ua = (request.headers.get("user-agent", "") if request else "")[:400]
    session = UserSession(
        id=sid,
        user_id=user_id,
        device=parse_device(ua),
        ip=client_ip(request),
        user_agent=ua,
        created_at=now,
        last_active_at=now,
    )
    db.add(session)
    return session


def sid_from_refresh(refresh_token: str) -> str:
    """从 refresh 令牌里取会话 ID。

    必须校验 type=refresh：access token 同样带 sid，
    不校验的话拿 access token 也能走登出接口把该设备的会话吊销。
    """
    payload = decode_token(refresh_token) or {}
    if payload.get("type") != "refresh":
        return ""
    return str(payload.get("sid") or payload.get("jti") or "")


async def revoke_session(db: AsyncSession, session: UserSession) -> None:
    session.revoked_at = datetime.now(timezone.utc)
    # 删除该会话的 refresh 登记（按 sid），旧令牌无法再换新
    try:
        from app.core.database import get_redis

        redis = get_redis()
        if redis:
            await redis.delete(f"rt:sid:{session.id}")
    except Exception:
        pass
