import re
"""图片发送配额：评论 / 私聊 / 群聊统一每人每天 20 张。

- 评论区：20 张/天
- 私聊：20 张/天
- 群聊：20 张/天（所有群合计，不按单个群重复给额度）

切日统一用北京时间（Asia/Shanghai）自然日，避免 UTC 早上 8 点才换额度。
自定义表情包（/uploads/stickers/ 下）属于聊天装扮，不占图片额度。
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_redis

DAILY_IMAGE_LIMITS = {
    "comment": 20,
    "direct": 20,
    "group": 20,
}
DAILY_IMAGE_LIMIT = 20  # 兼容旧引用

_BUSINESS_TZ = timezone(timedelta(hours=8))


def _business_day() -> str:
    return datetime.now(_BUSINESS_TZ).strftime("%Y%m%d")


def _seconds_until_business_midnight() -> int:
    now = datetime.now(_BUSINESS_TZ)
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(60, int((nxt - now).total_seconds()))


class ImageQuotaExceeded(Exception):
    """当日图片发送额度已用完"""


async def consume_image_quota(user, scope: str) -> int:
    """占用一次图片额度，返回今日已用数量。

    scope 取 comment / direct / group，三类统一 20 张。
    超级管理员不受限制（站点管理需要大量测试上传）。
    Redis 不可用时 fail-closed，避免因缓存故障导致无限上传打满磁盘。
    """
    if getattr(user, "role", "") == "super_admin":
        return 0
    user_id = getattr(user, "id", user)
    redis = get_redis()
    if not redis:
        raise ImageQuotaExceeded("图片额度服务暂时不可用，请稍后再试")
    try:
        limit = DAILY_IMAGE_LIMITS.get(scope, DAILY_IMAGE_LIMIT)
        day = _business_day()
        key = f"imgquota:{scope}:{user_id}:{day}"
        used = int(await redis.incr(key))
        if used == 1:
            await redis.expire(key, _seconds_until_business_midnight())
        if used > limit:
            try:
                await redis.decr(key)
            except Exception:
                pass
            raise ImageQuotaExceeded(f"今天最多发送 {limit} 张图片，明天再来吧")
        return used
    except ImageQuotaExceeded:
        raise
    except Exception:
        raise ImageQuotaExceeded("图片额度服务暂时不可用，请稍后再试")


async def remaining_image_quota(user, scope: str) -> Optional[int]:
    """查询今日剩余额度（前端展示用，失败返回 None）。超管返回 None 表示不限。"""
    if getattr(user, "role", "") == "super_admin":
        return None
    user_id = getattr(user, "id", user)
    redis = get_redis()
    if not redis:
        return None
    try:
        day = _business_day()
        used = int(await redis.get(f"imgquota:{scope}:{user_id}:{day}") or 0)
        return max(0, DAILY_IMAGE_LIMITS.get(scope, DAILY_IMAGE_LIMIT) - used)
    except Exception:
        return None


# 对象存储模式下上传接口返回的是绝对 URL，识别时必须同时兼容相对路径
_UPLOAD_PATH_RE = re.compile(r"^(?:https?://[^/\s]+)?(/uploads/[^\s?#]+)", re.IGNORECASE)


def _upload_path(content: str):
    """从消息内容里取出 /uploads/... 相对路径；不是本站图片则返回 None。"""
    c = (content or "").strip()
    m = _UPLOAD_PATH_RE.match(c)
    return m.group(1) if m else None


def is_image_message(content: str) -> bool:
    """聊天里「整条内容就是一张本站图片」即为图片消息（兼容绝对 URL）。"""
    path = _upload_path(content)
    if not path:
        return False
    return path.lower().split("?")[0].endswith((".webp", ".gif", ".png", ".jpg", ".jpeg"))


def is_sticker_content(content: str) -> bool:
    """整条内容是否为本站自定义表情包（不占图片额度，兼容绝对 URL）。"""
    path = _upload_path(content)
    return bool(path and path.lower().startswith("/uploads/stickers/"))
