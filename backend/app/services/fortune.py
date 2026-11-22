"""每日求签：运势分级、鼓励文案素材与卡片样式。

原则：无论抽到什么，文案都带鼓励性质；结果不佳时也一定给吉利寄语，
绝不出现「凶 / 倒霉 / 诸事不宜」这类负面断语。
"""
from typing import Dict, List

FORTUNE_TIERS: Dict[str, dict] = {
    "great": {
        "label": "上上签", "grade": "大吉", "stars": 5,
        "style": "fortune-holo", "icon": "🌈",
        "wish": "今天适合把一直想做的那件事开头，好运已经在路上了。",
    },
    "good": {
        "label": "上签", "grade": "中吉", "stars": 4,
        "style": "fortune-glow", "icon": "✨",
        "wish": "稳稳推进就好，你付出的每一分都会慢慢回响。",
    },
    "mild": {
        "label": "中签", "grade": "小吉", "stars": 3,
        "style": "fortune-soft", "icon": "🍀",
        "wish": "不急不躁，把小事做顺，今天也会有小小的惊喜。",
    },
    "steady": {
        "label": "平签", "grade": "顺遂", "stars": 2,
        "style": "fortune-plain", "icon": "🌿",
        "wish": "慢一点也没关系，平顺本身就是一种好运气。",
    },
    "rest": {
        "label": "养息签", "grade": "蓄势", "stars": 1,
        "style": "fortune-warm", "icon": "🌙",
        "wish": "今天宜歇一歇、攒点力气，明天自有顺风来，逢凶化吉、遇难呈祥。",
    },
}

# 权重：偏正向，但保留少量「需要休息」的结果，让抽签有真实感
TIER_WEIGHTS = [("great", 12), ("good", 28), ("mild", 30), ("steady", 20), ("rest", 10)]

ENCOURAGEMENTS: List[str] = [
    "你已经在往前走了，这本身就值得记一笔。",
    "把今天过顺，就是给自己攒下的一份底气。",
    "别急着要结果，好东西都在慢慢发酵。",
    "认真的人运气都不会太差，今天也一样。",
    "允许自己慢一点，节奏对了事情就顺了。",
    "你比昨天多懂了一点，这就是实打实的好运。",
    "今天的小小顺利，会连成往后的一大片好光景。",
    "累了就歇，歇完再出发，路一直都在。",
]

LUCKY_TAGS: List[str] = [
    "宜 写完那篇草稿", "宜 给旧代码做个了断", "宜 早点下班",
    "宜 和人好好说话", "宜 试一件没做过的事", "宜 收下别人的夸奖",
    "宜 备份", "宜 摸鱼五分钟", "宜 把问题问出口", "宜 睡个好觉",
]


def draw_fortune(seed: int) -> dict:
    """按服务端给的种子确定性抽签（结果由后端决定，前端无法指定）。"""
    import random

    rng = random.Random(seed)
    pool = [k for k, w in TIER_WEIGHTS for _ in range(w)]
    tier_key = rng.choice(pool)
    tier = FORTUNE_TIERS[tier_key]
    return {
        "tier": tier_key,
        "label": tier["label"],
        "grade": tier["grade"],
        "stars": tier["stars"],
        "style": tier["style"],
        "icon": tier["icon"],
        "wish": tier["wish"],
        "quote": rng.choice(ENCOURAGEMENTS),
        "lucky": rng.choice(LUCKY_TAGS),
    }
