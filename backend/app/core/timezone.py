from datetime import datetime, timezone
from typing import Optional

def utc_now() -> datetime:
    """
    返回带有时区信息 (tzinfo=timezone.utc) 的当前标准 UTC 时间对象。
    彻底取代已在 Python 3.12+ 废弃的无时区 naive `datetime.utcnow()`，
    杜绝 PostgreSQL / SQLite 在带有时区列 (TIMESTAMPTZ) 中因 naive 时间被误当成本地时区存储而导致的 8 小时时差。
    """
    return datetime.now(timezone.utc)

def format_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """
    将任意 datetime 安全序列化为符合 ISO 8601 标准的 UTC 字符串 (以 Z 结尾，例如 '2026-10-16T02:47:00Z')。
    若 dt 为无时区 naive 对象，则安全推定其原本表达的是 UTC 时间；
    若 dt 具有本地时区（如 Asia/Shanghai +08:00），则先准确转换至 UTC 时区再序列化为以 'Z' 结尾的字符串。
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
