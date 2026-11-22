import zlib
from datetime import datetime, timezone, timedelta
from uuid import UUID
import redis.asyncio as aioredis

# 匿名代号随机候选池（扩大至 30×30×1000 = 90 万组合，
# 此前 10×10×100 仅 1 万种，单帖约 118 个匿名用户即达 50% 撞名概率）
ANONYMOUS_ADJECTIVES = [
    "神秘", "机智", "从容", "沉稳", "灵动", "温顺", "敏锐", "热心", "专注", "逍遥",
    "低调", "清醒", "沉默", "孤勇", "执拗", "缜密", "坦率", "冷静", "轻盈", "炽热",
    "苍穹", "深空", "冷冽", "温柔", "坚韧", "自由", "散漫", "缄默", "纯粹", "执迷",
]
ANONYMOUS_ANIMALS = [
    "雪豹", "海獭", "考拉", "羚羊", "夜莺", "极客", "白鲸", "赤狐", "松鼠", "信天翁",
    "猞猁", "貂蝉", "狼獾", "旅鼠", "银狐", "苍鹰", "游隼", "白鲨", "棱龟", "河豚",
    "刺猬", "水獭", "貉", "獾", "貂", "鹈鹕", "火烈鸟", "鹿豚", "马来貘", "跳兔",
]

# 等级对应的每日匿名评论上限
LEVEL_ANON_QUOTAS = {
    0: 0,   # 见习生禁止匿名
    1: 3,   # Lv.1: 3次
    2: 5,   # Lv.2: 5次
    3: 8,   # Lv.3: 8次
    4: 12,  # Lv.4: 12次
    5: 15,  # Lv.5: 15次
    6: 20   # Lv.6: 20次
}

def generate_anonymous_alias(post_id: UUID, user_id: UUID, is_post_author: bool = False) -> str:
    """
    生成单帖一致、跨帖动态变化的匿名别名
    算法: CRC32(post_id + user_id) 取模词库
    """
    if is_post_author:
        # 楼主本人匿名评论时带有专属身份提示，防止自导自演
        seed = f"{post_id}:{user_id}:author"
        hash_val = zlib.crc32(seed.encode("utf-8"))
        suffix = hash_val % 100
        return f"匿名楼主#{suffix:02d}"

    seed = f"{post_id}:{user_id}"
    hash_val = zlib.crc32(seed.encode("utf-8"))

    adj_idx = (hash_val >> 16) % len(ANONYMOUS_ADJECTIVES)
    animal_idx = hash_val % len(ANONYMOUS_ANIMALS)
    suffix = (hash_val // 100) % 1000

    return f"{ANONYMOUS_ADJECTIVES[adj_idx]}{ANONYMOUS_ANIMALS[animal_idx]}#{suffix:03d}"

def get_seconds_until_midnight() -> int:
    """计算距离今天 23:59:59 的剩余秒数"""
    now = datetime.now(timezone.utc)
    midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((midnight - now).total_seconds())

async def check_and_consume_anon_quota(user_id: UUID, level: int, redis: aioredis.Redis) -> int:
    """
    检查并原子扣减今日匿名额度。
    若未超限返回今日剩余次数；若超限抛出 ValueError。
    """
    max_quota = LEVEL_ANON_QUOTAS.get(level, 0)
    if max_quota <= 0:
        raise ValueError("当前账号等级暂不支持使用匿名评论功能（需升级至 Lv.1 正式会员）")

    today_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    key = f"community:anon_quota:{user_id}:{today_str}"

    used = await redis.incr(key)
    if used == 1:
        # 首次访问设置过期时间至当天午夜
        await redis.expire(key, get_seconds_until_midnight())

    if used > max_quota:
        await redis.decr(key)
        raise ValueError(f"今日匿名发言额度已耗尽 (每日上限 {max_quota} 次)")

    return max_quota - used

async def get_remaining_anon_quota(user_id: UUID, level: int, redis: aioredis.Redis) -> int:
    """查询今日剩余匿名次数"""
    max_quota = LEVEL_ANON_QUOTAS.get(level, 0)
    if max_quota <= 0:
        return 0

    today_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    key = f"community:anon_quota:{user_id}:{today_str}"
    used_str = await redis.get(key)
    used = int(used_str) if used_str else 0
    return max(0, max_quota - used)
