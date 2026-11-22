"""勋章定义种子与查询辅助"""

from typing import List, Tuple

from sqlalchemy import select
from app.core.database import AsyncSessionLocal
from app.models.achievement import AchievementDef

# (code, name, subtitle, description, icon, series, tier, target)
SERIES_SEEDS: List[Tuple[str, str, str, str, str, str, int, int]] = []

_SERIES_META = [
    # 系列, 名称, 副标题, 图标, [铜, 银, 金, 钻]
    ("quill", "执笔", "Writer", "pen", [1, 10, 50, 200]),
    ("resonance", "共鸣", "Resonance", "heart", [10, 100, 1000, 10000]),
    ("dwell", "常驻", "Dweller", "calendar", [7, 30, 100, 365]),
    ("bond", "连接", "Connector", "users", [5, 50, 200, 1000]),
    ("debate", "辩手", "Debater", "message", [10, 100, 500, 2000]),
    ("library", "藏书", "Collector", "book", [10, 50, 200, 1000]),
    ("evangel", "布道", "Evangelist", "code", [5, 20, 50, 150]),
    ("nightowl", "夜行", "Night Owl", "moon", [3, 10, 30, 100]),
    ("archae", "考古", "Archaeologist", "compass", [10, 50, 100, 500]),
    ("anniv", "纪年", "Anniversary", "award", [1, 2, 3, 5]),
]
_TIER_NAMES = ["铜", "银", "金", "钻"]
_TIER_UNITS = ["篇", "次", "天", "人", "条", "本", "页", "年"]


def _build_series() -> List[Tuple[str, str, str, str, str, str, int, int, str, str]]:
    out = []
    unit_map = {
        "quill": "篇", "resonance": "赞", "dwell": "天", "bond": "人", "debate": "条",
        "library": "次", "evangel": "篇", "nightowl": "次", "archae": "页", "anniv": "年",
    }
    for series, name, subtitle, icon, targets in _SERIES_META:
        unit = unit_map.get(series, "")
        for tier, target in enumerate(targets):
            code = f"{series}_{tier}"
            out.append(
                (
                    code,
                    f"{name}·{_TIER_NAMES[tier]}",
                    subtitle,
                    f"累计达到 {target} {unit}",
                    icon,
                    "series",
                    series,
                    tier,
                    target,
                )
            )
    return out


# 一次性成就（不含分级）
SPECIAL_SEEDS = [
    ("special_first_post", "破冰者", "First Commit", "发布第一篇正式文章", "rocket", "special", 0, 1),
    ("special_first_comment", "初次交锋", "First Reply", "发出第一条评论", "message", "special", 0, 1),
    ("special_featured", "精华作者", "Featured", "文章被设为精华", "sparkles", "special", 1, 1),
    ("special_100_likes", "百赞达成", "Century", "单篇文章获得 100 赞", "target", "special", 2, 1),
    ("special_10k_words", "万字长文", "Heavy Payload", "单篇正文超过一万字", "scroll", "special", 2, 1),
    ("special_helpful", "及时雨", "Helper", "回答被采纳 10 次", "handshake", "special", 1, 10),
    ("special_bug_hunter", "捉虫专家", "Bug Hunter", "反馈的 Bug 被确认修复", "bug", "special", 1, 1),
    ("special_streak_30", "月满签到", "Streak 30", "连续签到 30 天", "calendar", "special", 2, 30),
    ("special_profile_complete", "装备齐全", "Fully Equipped", "补全头像、简介、技术栈与主页链接", "layers", "special", 0, 1),
    ("special_veteran", "版本见证", "Release Witness", "参与三次大版本更新讨论", "satellite", "special", 1, 3),
]


async def ensure_achievement_defs() -> int:
    """幂等写入内置勋章定义，返回新增条数"""
    rows = _build_series()
    payload = [
        {
            "code": code,
            "name": name,
            "subtitle": subtitle,
            "description": description,
            "icon": icon,
            "category": category,
            "series": series,
            "tier": tier,
            "target": target,
            "hidden": category == "hidden",
        }
        for (code, name, subtitle, description, icon, category, series, tier, target) in rows
    ]
    for item in SPECIAL_SEEDS:
        code, name, subtitle, description, icon, category, tier, target = item
        payload.append(
            {
                "code": code,
                "name": name,
                "subtitle": subtitle,
                "description": description,
                "icon": icon,
                "category": category,
                "series": None,
                "tier": tier,
                "target": target,
                "hidden": category == "hidden",
            }
        )

    created = 0
    changed = 0
    async with AsyncSessionLocal() as db:
        existing_rows = {row.code: row for row in (await db.execute(select(AchievementDef))).scalars().all()}
        for item in payload:
            row = existing_rows.get(item["code"])
            if row is not None:
                # 内置定义允许同步图标 / 名称 / 副标题 / 描述（例如补充「发现方式」提示），
                # 自定义勋章由管理员编辑，保持原样不动
                if not row.custom:
                    for field in ("name", "subtitle", "description", "icon", "hidden", "target"):
                        if getattr(row, field) != item[field]:
                            setattr(row, field, item[field])
                            changed += 1
                continue
            db.add(AchievementDef(**item))
            created += 1
        if created or changed:
            await db.commit()
    return created + changed
