"""节日彩蛋 / 限时节日勋章。

规则：
- 公历节日按 (月, 日) 判定；农历节日（春节/端午/中秋）用 2026-2028 的固定日期表。
- 只在当天有效：用户当天第一次进入站点自动解锁，当天可佩戴，隔天自然失效。
- 每个节日对应一枚隐藏成就，code 统一为 festival_<key>。
"""
from datetime import date
from typing import Dict, List, Optional

# (code, 名称, 图标, 月, 日, 庆祝文案)
SOLAR_FESTIVALS = [
    ("festival_newyear", "跨年烟火", "🎆", 1, 1, "新的一年，继续做点有意思的东西"),
    ("festival_valentine", "心动信号", "💝", 2, 14, "今天适合把「在吗」说出口"),
    ("festival_aprilfool", "愚人节限定", "🃏", 4, 1, "今天说的每句话都可能不算数"),
    ("festival_labor", "劳动最光荣", "🛠️", 5, 1, "今天也是认真搬砖的一天"),
    ("festival_children", "童心未泯", "🎈", 6, 1, "成年人也需要一个气球"),
    ("festival_halloween", "万圣夜行", "🎃", 10, 31, "不给糖就捣乱，或者来点 bug"),
    ("festival_singles", "剁手节", "🛒", 11, 11, "购物车已清空，钱包已破产"),
    ("festival_xmas_eve", "平安夜", "🎄", 12, 24, "平安夜快乐，愿你今晚睡得比服务器还稳"),
    ("festival_christmas", "圣诞快乐", "🎅", 12, 25, "圣诞老人说：今年你没写 bug"),
]

# 农历节日：穷举未来三年，避免引入农历转换依赖
LUNAR_FESTIVALS: Dict[str, dict] = {
    "spring": {
        "name": "春节",
        "icon": "🧧",
        "wish": "新年快乐，红包拿来",
        "dates": [(2026, 2, 17), (2027, 2, 6), (2028, 1, 26)],
    },
    "dragonboat": {
        "name": "端午安康",
        "icon": "🐉",
        "wish": "吃粽子，别内卷",
        "dates": [(2026, 6, 19), (2027, 6, 9), (2028, 5, 28)],
    },
    "midautumn": {
        "name": "中秋团圆",
        "icon": "🌕",
        "wish": "月圆人圆，代码也别出 bug",
        "dates": [(2026, 9, 25), (2027, 9, 15), (2028, 10, 3)],
    },
}


def today_festival(today: Optional[date] = None) -> Optional[dict]:
    """返回今天的节日（没有则 None）。"""
    d = today or date.today()
    for code, name, icon, m, dd, wish in SOLAR_FESTIVALS:
        if (d.month, d.day) == (m, dd):
            return {"code": code, "name": name, "icon": icon, "wish": wish}

    for key, meta in LUNAR_FESTIVALS.items():
        for (y, m, dd) in meta["dates"]:
            if (d.year, d.month, d.day) == (y, m, dd):
                return {
                    "code": f"festival_{key}",
                    "name": meta["name"],
                    "icon": meta["icon"],
                    "wish": meta["wish"],
                }
    return None


def all_festival_defs() -> List[dict]:
    """供迁移种子使用：全部节日勋章定义。"""
    defs = [
        {"code": code, "name": name, "icon": icon, "wish": wish}
        for code, name, icon, _m, _d, wish in SOLAR_FESTIVALS
    ]
    defs += [
        {"code": f"festival_{key}", "name": meta["name"], "icon": meta["icon"], "wish": meta["wish"]}
        for key, meta in LUNAR_FESTIVALS.items()
    ]
    return defs
