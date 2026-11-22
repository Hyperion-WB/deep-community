"""邮箱验证码：生成、存储、校验。

存储复用 Redis（未配置时自动使用内存 Mock），键设计：
- email:code:{purpose}:{email}          验证码本体，带 TTL
- email:code:cooldown:{purpose}:{email} 重发冷却
- email:code:attempt:{purpose}:{email}  校验失败计数
"""

import secrets
from typing import Tuple

from app.core.config import settings
from app.core.database import get_redis

VALID_PURPOSES = {"register", "reset", "bind_email"}


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _keys(purpose: str, email: str) -> Tuple[str, str, str]:
    key = normalize_email(email)
    return (
        f"email:code:{purpose}:{key}",
        f"email:code:cooldown:{purpose}:{key}",
        f"email:code:attempt:{purpose}:{key}",
    )


async def cooldown_remaining(purpose: str, email: str) -> int:
    """返回剩余冷却秒数，0 表示可以发送。"""
    redis = get_redis()
    if not redis:
        return 0
    try:
        if await redis.get(_keys(purpose, email)[1]):
            return settings.EMAIL_CODE_RESEND_SECONDS
    except Exception:
        pass
    return 0


async def issue_code(purpose: str, email: str) -> str:
    """生成并写入验证码（不负责投递）。"""
    if purpose not in VALID_PURPOSES:
        raise ValueError("invalid purpose")
    redis = get_redis()
    if not redis:
        raise RuntimeError("验证码服务暂不可用")

    code = f"{secrets.randbelow(1000000):06d}"
    code_key, cooldown_key, attempt_key = _keys(purpose, email)
    await redis.set(code_key, code, ex=settings.EMAIL_CODE_TTL_SECONDS)
    await redis.set(cooldown_key, "1", ex=settings.EMAIL_CODE_RESEND_SECONDS)
    try:
        await redis.delete(attempt_key)
    except Exception:
        pass
    return code


async def verify_code(purpose: str, email: str, code: str) -> Tuple[bool, str]:
    """校验并消费验证码，返回 (是否通过, 失败原因)。"""
    redis = get_redis()
    if not redis:
        return False, "验证码服务暂不可用，请稍后重试"

    code_key, _, attempt_key = _keys(purpose, email)
    try:
        stored = await redis.get(code_key)
    except Exception:
        return False, "验证码服务暂不可用，请稍后重试"

    if not stored:
        return False, "验证码已失效，请重新获取"
    if str(code or "").strip() != stored:
        try:
            attempts = await redis.incr(attempt_key)
            try:
                await redis.expire(attempt_key, settings.EMAIL_CODE_TTL_SECONDS)
            except Exception:
                pass
            if attempts >= settings.EMAIL_CODE_MAX_ATTEMPTS:
                await redis.delete(code_key)
                return False, "验证码错误次数过多，请重新获取"
        except Exception:
            pass
        return False, "验证码不正确"

    try:
        await redis.delete(code_key)
        await redis.delete(attempt_key)
    except Exception:
        pass
    return True, "ok"
