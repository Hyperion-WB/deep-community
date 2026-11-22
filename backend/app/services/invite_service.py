# -*- coding: utf-8 -*-
"""邀请码配额与生成服务。

配额规则（与产品设定一致，滑动 72 小时窗口）：
- super_admin: 无限量，30 天有效
- admin / moderator: 每 72 小时 10 个，30 天有效
- 普通用户 Lv.6: 每 72 小时 3 个，72 小时有效
- 普通用户 Lv.3 ~ Lv.5: 每 72 小时 1 个，72 小时有效
- auditor (只读审计员) 与 Lv.0 ~ Lv.2: 无邀请码生成资格

有效期由服务端按身份强制决定，不接受客户端传入。
"""

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, InviteCode

WINDOW_HOURS = 72

# 角色固定规则
_ROLE_RULES = {
    "super_admin": {"limit": None, "valid_days": 30},
    "admin": {"limit": 10, "valid_days": 30},
    "moderator": {"limit": 10, "valid_days": 30},
    "auditor": None,  # 只读审计员无生成资格
}


def _rule_for(user: User) -> Optional[dict]:
    """返回该用户的邀请码规则；None 表示无资格。"""
    rule = _ROLE_RULES.get(user.role)
    if rule is not None:
        return rule if rule.get("limit") is not None or rule["valid_days"] else rule
    # 普通用户按等级
    level = user.level or 0
    if level >= 6:
        return {"limit": 3, "valid_days": 3}
    if level >= 3:
        return {"limit": 1, "valid_days": 3}
    return None


def _window_start() -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)


async def get_invite_quota(db: AsyncSession, user: User) -> dict:
    """查询用户的邀请码配额与生成资格。"""
    rule = _rule_for(user)
    if not rule:
        return {
            "eligible": False,
            "limit": 0,
            "remaining": 0,
            "valid_days": 0,
            "window_hours": WINDOW_HOURS,
            "used_in_window": 0,
            "role": user.role,
            "level": user.level or 0,
        }

    used_in_window = (await db.execute(
        select(func.count(InviteCode.id)).where(
            InviteCode.generator_id == user.id,
            InviteCode.created_at >= _window_start(),
        )
    )).scalar() or 0

    limit = rule["limit"]
    remaining = None if limit is None else max(0, limit - used_in_window)
    return {
        "eligible": True,
        "limit": limit,                # None = 无限
        "remaining": remaining,
        "valid_days": rule["valid_days"],
        "window_hours": WINDOW_HOURS,
        "used_in_window": used_in_window,
        "role": user.role,
        "level": user.level or 0,
    }


async def generate_invite_codes(
    db: AsyncSession, user: User, count: int
) -> Tuple[Optional[List[str]], Optional[datetime], Optional[str]]:
    """按身份配额生成邀请码。

    返回 (codes, expires_at, error)；error 非 None 时表示生成失败。
    count 由调用方钳制，此处做最终配额校验（防并发超发按窗口计数兜底）。
    """
    quota = await get_invite_quota(db, user)
    if not quota["eligible"]:
        return None, None, "当前身份或等级暂无邀请码生成资格 (需 Lv.3 及以上或管理角色)"

    limit = quota["limit"]
    if limit is not None:
        count = min(count, quota["remaining"])
        if count <= 0:
            return None, None, f"邀请码生成配额已用尽 (每 {WINDOW_HOURS} 小时 {limit} 个)，请稍后再试"
    else:
        count = min(count, 50)

    valid_days = quota["valid_days"]
    expires = datetime.now(timezone.utc) + timedelta(days=valid_days)
    codes: List[str] = []

    for _ in range(count):
        # 码碰撞兜底：唯一约束冲突时重试新随机码（8 位十六进制空间足够大，实际极少触发）
        for _attempt in range(3):
            code = f"INV-{secrets.token_hex(4).upper()}"
            exists = (await db.execute(
                select(InviteCode.id).where(InviteCode.code == code)
            )).scalar_one_or_none()
            if not exists:
                break
        db.add(InviteCode(
            code=code,
            generator_id=user.id,
            expires_at=expires,
        ))
        codes.append(code)

    await db.commit()
    return codes, expires, None
