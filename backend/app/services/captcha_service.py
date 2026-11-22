"""Cloudflare Turnstile 人机校验。

启用条件：同时配置 TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET_KEY。
未配置时所有校验直接放行，保证旧部署不受影响。
"""

from typing import Optional

from app.core.config import settings
from app.core.database import get_redis


def is_captcha_enabled() -> bool:
    return bool(settings.TURNSTILE_SITE_KEY and settings.TURNSTILE_SECRET_KEY)


def site_key() -> str:
    return settings.TURNSTILE_SITE_KEY if is_captcha_enabled() else ""


async def verify_captcha(token: str, remote_ip: str = "") -> bool:
    """校验 Turnstile token；未启用时恒为 True。"""
    if not is_captcha_enabled():
        return True
    if not token:
        return False

    import httpx

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            res = await client.post(
                "https://challenges.cloudflare.com/turnstile/v0/siteverify",
                data={
                    "secret": settings.TURNSTILE_SECRET_KEY,
                    "response": token,
                    "remoteip": remote_ip or "",
                },
            )
            data = res.json() or {}
            return bool(data.get("success"))
    except Exception:
        # 校验服务不可用时 fail-open，避免 Cloudflare 抖动导致全站无法登录
        return True


def _failure_key(identifier: str) -> str:
    return f"login:fail:{(identifier or '').strip().lower()[:64]}"


async def login_requires_captcha(identifier: str) -> bool:
    """同一账号密码错误达到阈值后，登录必须带人机校验。"""
    if not is_captcha_enabled():
        return False
    redis = get_redis()
    if not redis:
        return False
    try:
        if not await redis.exists(f"login:lock:{identifier.strip().lower()[:64]}"):
            count = int(await redis.get(_failure_key(identifier)) or 0)
            return count >= settings.CAPTCHA_LOGIN_AFTER_FAILURES
    except Exception:
        return False
    return False


async def email_send_requires_captcha(ip: str) -> bool:
    """同一 IP 在窗口内发送验证码过多时，强制人机校验。"""
    if not is_captcha_enabled():
        return False
    redis = get_redis()
    if not redis:
        return False
    try:
        count = int(await redis.get(f"captcha:email:ip:{ip or 'unknown'}") or 0)
        return count >= settings.CAPTCHA_EMAIL_AFTER_SENDS
    except Exception:
        return False


async def count_email_send(ip: str) -> None:
    if not is_captcha_enabled():
        return
    redis = get_redis()
    if not redis:
        return
    try:
        key = f"captcha:email:ip:{ip or 'unknown'}"
        await redis.incr(key)
        await redis.expire(key, settings.CAPTCHA_EMAIL_WINDOW_SECONDS)
    except Exception:
        pass
