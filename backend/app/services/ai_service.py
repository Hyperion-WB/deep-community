"""AI 管理：配置读写、模型拉取、自动评论生成。

配置全部落在 system_settings（value 已扩为 TEXT），重启/跨天不丢。
AI 以真实 user 行（is_bot=True）身份出现在评论区，只评论、不做其它操作。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system import SystemSetting
from app.models.user import User

logger = logging.getLogger(__name__)

# 内置常见厂商（base_url 由管理端可改，支持自定义）
AI_VENDORS = [
    {"key": "openai", "name": "OpenAI", "base_url": "https://api.openai.com/v1"},
    {"key": "deepseek", "name": "DeepSeek", "base_url": "https://api.deepseek.com/v1"},
    {"key": "dashscope", "name": "通义千问", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
    {"key": "zhipu", "name": "智谱 GLM", "base_url": "https://open.bigmodel.cn/api/paas/v4"},
    {"key": "moonshot", "name": "Moonshot", "base_url": "https://api.moonshot.cn/v1"},
    {"key": "siliconflow", "name": "硅基流动", "base_url": "https://api.siliconflow.cn/v1"},
    {"key": "gemini", "name": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai"},
    {"key": "ark", "name": "火山方舟 · 豆包", "base_url": "https://ark.cn-beijing.volces.com/api/v3"},
    {"key": "qianfan", "name": "百度千帆 · 文心", "base_url": "https://qianfan.baidubce.com/v2"},
    {"key": "hunyuan", "name": "腾讯混元", "base_url": "https://api.hunyuan.cloud.tencent.com/v1"},
    {"key": "openrouter", "name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1"},
    {"key": "ollama", "name": "Ollama（本地）", "base_url": "http://localhost:11434/v1"},
    {"key": "custom", "name": "自定义", "base_url": ""},
]

AI_KEYS = {
    "ai_vendor": "openai",
    "ai_base_url": "https://api.openai.com/v1",
    "ai_model": "",
    "ai_api_key": "",
    "ai_user_name": "AI 小助手",
    "ai_user_avatar": "",
    "ai_style": "humor",
    "ai_enabled": "0",
    "ai_auto_comment": "1",
    "ai_daily_limit": "50",
    "ai_reply_buffer_sec": "20",   # 相邻两条 AI 回复的最小间隔，防止高频调用返回空结果
    # 关闭推理模型的「思考过程」：省 token、避免 content 被 reasoning 吃掉。
    "ai_disable_thinking": "0",
    # ---- 人格（兼容 SillyTavern Character Card V2 数据格式）----
    "ai_persona_name": "",
    "ai_persona_desc": "",
    "ai_persona_card": "",          # 上传的角色卡原始 JSON（仅采用数据格式，不复制其代码）
    "ai_catchphrase": "",           # 口头禅，按概率出现在句尾
    # ---- 回复设置 ----
    "ai_reply_mode": "hybrid",      # ai / fixed / hybrid
    "ai_reply_phrases": "",         # 一行一条，管理员直接设定的回复语池
    "ai_emotion_intensity": "50",   # 情绪强度 0-100，影响 emoji / 感叹号 / 句长
    # ---- 趣味 ----
    "ai_mood_enabled": "1",         # 每日心情
    "ai_fun_enabled": "1",          # 口头禅 + 周四彩蛋联动
}

# 8 种情感：每种都有「必须做 / 禁止做 / 示范」，不再是换一个形容词那么微弱。
EMOTION_PRESETS = {
    "humor": {
        "label": "梗王", "icon": "😂", "hint": "一句极客梗收尾", "emoji": 1,
        "tone": "你是个爱玩梗的老网友。必须用正文里的某个细节造一个轻巧的极客梗或谐音梗，"
                "梗要扣题，不要硬凑网络流行语。结尾可以带 1 个 emoji。",
        "examples": ["这波优化像给滚动条做了个热更新，连加班都优雅了😂",
                     "看完只想给编译器的脾气点个赞，它比我还倔。"],
    },
    "normal": {
        "label": "冷面观察员", "icon": "😐", "hint": "零情绪、只陈述事实", "emoji": 0,
        "tone": "你是个极度克制的观察者。只用陈述句，指出正文里一个具体事实或取舍，"
                "不夸奖、不吐槽、不用感叹号、不用 emoji、不提问。语气平到有点好笑。",
        "examples": ["这里把轮询换成事件驱动，省下的是长连接以外的那部分开销。",
                     "第二步依赖第一步的返回值，顺序在文中没有写明。"],
    },
    "warm": {
        "label": "温柔前辈", "icon": "🫶", "hint": "共情 + 具体鼓励", "emoji": 1,
        "tone": "你是个带过很多新人的前辈。先接住作者付出的具体劳动（要说出是哪一点），"
                "再给一句温和的肯定或建议。用「你」，不用术语压人，不要说教。",
        "examples": ["把踩过的坑一条条写下来，后来的人能少熬一个夜，辛苦了🫶",
                     "愿意把失败的那版也放上来，这份坦诚比结论更值钱。"],
    },
    "sharp": {
        "label": "毒舌评审", "icon": "🔪", "hint": "挑一个具体毛病 + 给解法", "emoji": 0,
        "tone": "你是嘴很刁但很讲理的评审。必须点名正文里一个具体漏洞、含糊处或代价，"
                "再补一句可执行的建议。犀利但不人身攻击、不否定作者本人、不用脏话。",
        "examples": ["并发数上去了，回滚方案却一个字没提，先补个开关再说。",
                     "这里省掉的那层校验，会在凌晨三点连本带利还回来。"],
    },
    "hype": {
        "label": "捧场王", "icon": "🎉", "hint": "夸张夸奖 + 感叹号", "emoji": 2,
        "tone": "你是最会捧场的那位同事。必须引用正文里一个具体亮点（不要泛泛说「写得好」），"
                "用略夸张的语气夸它，允许 1-2 个感叹号和 emoji，但不要空喊口号。",
        "examples": ["这张压测曲线也太漂亮了，看完想立刻把旧方案扔进回收站🎉",
                     "连注释都替读者想好了，这份体贴值得全场鼓掌！！"],
    },
    "nerd": {
        "label": "考据党", "icon": "🔍", "hint": "必提一个技术细节", "emoji": 0,
        "tone": "你是爱抠细节的技术考据党。必须紧扣正文里出现的一个具体名词、参数、"
                "数据结构或机制，补一句与之相关的延伸知识或边界条件。带点书呆子气，"
                "不要跑题科普，不要 emoji。",
        "examples": ["用 bigint 存序号确实稳，不过跨库合并时还得留个逻辑时钟。",
                     "这里的 LRU 在批量扫描下会退化，命中率曲线值得单独测一次。"],
    },
    "poet": {
        "label": "文艺比喻", "icon": "🌙", "hint": "一个生活化比喻收尾", "emoji": 1,
        "tone": "你习惯用生活里的画面理解技术。必须先准确回应正文的一个具体内容，"
                "再给一个贴切、不矫情的生活化比喻收尾。不要用技术黑话，不要堆形容词。",
        "examples": ["这层缓存像家门口那盏感应灯，人还没到就先亮了🌙",
                     "把重试拆成三次，像给一封没寄到的信留了三个地址。"],
    },
    "curious": {
        "label": "好奇宝宝", "icon": "❓", "hint": "以具体问题结尾", "emoji": 0,
        "tone": "你是个认真读完还想知道更多的读者。先说一句你从正文里读到的具体信息，"
                "然后针对正文里没交代清楚的一个细节提一个问题，必须以问号结尾。"
                "不要问「还有吗」这种空问题，不要自问自答。",
        "examples": ["把状态收敛到单点之后，读写都轻了，那故障切换时这段状态怎么续上？",
                     "这里的采样窗口固定 5 秒，流量突刺时会不会刚好被切在两格之间？"],
    },
}

# 兼容旧调用：保留 STYLE_PROMPTS 名称
STYLE_PROMPTS = {k: v["tone"] for k, v in EMOTION_PRESETS.items()}

DAILY_MOODS = [
    "刚灌完第一杯咖啡，脑子刚开机",
    "摸鱼模式，键盘都是温的",
    "被一个 CI 红了半小时，心情微妙",
    "今天格外好说话，看什么都顺眼",
    "debug 到凌晨，现在说话有点飘",
    "刚下班，语气里带着一点解放感",
    "周末前夜，注意力只剩三格电",
    "认真模式，想把每句话都说准",
]
THURSDAY_MOOD = "疯狂星期四限定心情：满脑子都是 V 我 50，但绝不硬蹭无关话题"


def daily_mood() -> str:
    """按东八区日期确定性抽取心情：同一天重启/多 worker 结果一致。"""
    import hashlib
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone(timedelta(hours=8)))
    if now.weekday() == 3:
        return THURSDAY_MOOD
    seed = now.date().isoformat().encode()
    return DAILY_MOODS[int(hashlib.md5(seed).hexdigest(), 16) % len(DAILY_MOODS)]


def parse_character_card(raw: str) -> Dict[str, Any]:
    """解析开源角色卡（SillyTavern / TavernAI Character Card V1 & V2）。

    支持 {"spec":"chara_card_v2","data":{...}}、V1 扁平格式、以及直接给 data。
    只采纳数据格式，不引入任何上游代码。
    """
    import json as _json

    obj = _json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(obj, dict):
        raise ValueError("角色卡必须是一个 JSON 对象")
    data = obj.get("data") if isinstance(obj.get("data"), dict) else obj
    pick = lambda *keys: next((str(data[k]).strip() for k in keys
                               if data.get(k) and str(data[k]).strip()), "")
    return {
        "name": pick("name", "角色名", "角色名称"),
        "description": pick("description", "描述", "性格", "背景"),
        "personality": pick("personality", "persona", "性格标签"),
        "scenario": pick("scenario", "场景", "设定"),
        "first_mes": pick("first_mes", "开场白"),
        "mes_example": pick("mes_example", "对话示例", "示例对话"),
        "system_prompt": pick("system_prompt", "系统提示", "系统指令"),
        "post_history_instructions": pick("post_history_instructions", "补充指令"),
        "tags": data.get("tags") if isinstance(data.get("tags"), list) else [],
        "spec": str(obj.get("spec") or "chara_card_v1"),
    }


def persona_block(cfg: Dict[str, str]) -> str:
    """把人格卡 + 自定义描述拼成 system prompt 的角色段。"""
    parts: List[str] = []
    card: Dict[str, Any] = {}
    if (cfg.get("ai_persona_card") or "").strip():
        try:
            card = parse_character_card(cfg["ai_persona_card"])
        except Exception:
            card = {}

    name = (cfg.get("ai_persona_name") or "").strip() or card.get("name") or ""
    desc = (cfg.get("ai_persona_desc") or "").strip()
    if name:
        parts.append(f"【你的名字】{name}")
    if card.get("description"):
        parts.append(f"【人设背景】{card['description'][:600]}")
    if desc:
        parts.append(f"【管理员设定的性格】{desc[:800]}")
    if card.get("personality"):
        parts.append(f"【性格标签】{card['personality'][:300]}")
    if card.get("scenario"):
        parts.append(f"【场景设定】{card['scenario'][:300]}")
    if card.get("system_prompt"):
        parts.append(f"【角色卡附加指令】{card['system_prompt'][:600]}")
    if card.get("mes_example"):
        parts.append(f"【角色说话范例（学语气，不要照抄内容）】{card['mes_example'][:600]}")
    if card.get("post_history_instructions"):
        parts.append(f"【角色卡收尾要求】{card['post_history_instructions'][:300]}")
    if parts:
        parts.append("以上人设只影响说话方式，绝对不要在评论里自我介绍、报名字或提及设定本身。")
    return "\n".join(parts)


def reply_phrases(cfg: Dict[str, str]) -> List[str]:
    raw = cfg.get("ai_reply_phrases") or ""
    return [ln.strip()[:160] for ln in raw.splitlines() if ln.strip()][:60]


def apply_fun(text: str, cfg: Dict[str, str]) -> str:
    """趣味层：口头禅按概率追加，长度仍受控。"""
    import random as _random

    if cfg.get("ai_fun_enabled") != "1" or not text:
        return text
    phrase = (cfg.get("ai_catchphrase") or "").strip()
    if phrase and len(text) + len(phrase) <= 150 and _random.random() < 0.28:
        sep = "" if phrase[0] in "，。！？!?…~～" else " "
        text = f"{text.rstrip('。！？!?…')}{sep}{phrase}"
    return text.strip()


async def load_ai_config(db: AsyncSession) -> Dict[str, str]:
    rows = (await db.execute(select(SystemSetting).where(SystemSetting.key.in_(list(AI_KEYS.keys()))))).scalars().all()
    cfg = dict(AI_KEYS)
    for r in rows:
        if r.value is not None:
            cfg[r.key] = r.value
    return cfg


async def save_ai_config(db: AsyncSession, values: Dict[str, Any]) -> Dict[str, str]:
    for k, v in values.items():
        if k not in AI_KEYS or v is None:
            continue
        row = (await db.execute(select(SystemSetting).where(SystemSetting.key == k))).scalar_one_or_none()
        text = str(v)
        if row:
            row.value = text
        else:
            db.add(SystemSetting(key=k, value=text, description="AI 管理配置"))
    await db.commit()
    return await load_ai_config(db)


async def fetch_models(base_url: str, api_key: str) -> List[str]:
    """拉取 OpenAI 兼容的 /models 列表；自定义端点同样适用。"""
    url = base_url.rstrip("/") + "/models"
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(url, headers={"Authorization": f"Bearer {api_key}"})
        res.raise_for_status()
        data = res.json()
    items = data.get("data") if isinstance(data, dict) else data
    out: List[str] = []
    for it in items or []:
        if isinstance(it, dict):
            mid = it.get("id") or it.get("name")
            if mid:
                out.append(str(mid))
        elif isinstance(it, str):
            out.append(it)
    return sorted(set(out))


async def chat_completion(cfg: Dict[str, str], messages: List[Dict[str, str]]) -> Dict[str, Any]:
    """返回 {text, finish_reason}。

    只认 message.content：推理模型的 reasoning_content 是「思考过程」，
    曾经被当成正文兜底，结果把 "Analyze the Request: ..." 这种提示词复述直接发进了评论区。
    """
    base = (cfg.get("ai_base_url") or "").rstrip("/")
    key = cfg.get("ai_api_key") or ""
    model = cfg.get("ai_model") or ""
    if not base or not key or not model:
        raise RuntimeError("AI 未配置完整（base_url / api_key / model）")
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.7,
        # 推理模型：max_tokens 太小会在「思考过程」阶段被截断，content 直接为空
        # （以前的 512 就是这么把 CoT 当正文发出去的）。2400 足够它想完再写 1~2 句。
        "max_tokens": 2400,
    }
    if (cfg.get("ai_disable_thinking") or "0") == "1":
        # 仅部分厂商支持的扩展参数；关掉思考后 content 直接就绪，省钱也更快
        payload["enable_thinking"] = False
    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(
            base + "/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=payload,
        )
        res.raise_for_status()
        data = res.json()
    try:
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        raw = msg.get("content")
        if isinstance(raw, list):
            # 少数网关返回多模态分片：[{type:"text", text:"..."}]
            raw = "".join(
                str(part.get("text") or "") for part in raw if isinstance(part, dict)
            )
        text = (raw or "").strip()
        return {"text": text, "finish_reason": choice.get("finish_reason") or ""}
    except Exception:
        raise RuntimeError("模型返回格式异常")


async def get_ai_user(db: AsyncSession, cfg: Dict[str, str]) -> Optional[User]:
    """AI 机器人账号：is_bot=True，不能登录。名称/头像可在管理端改。"""
    name = (cfg.get("ai_user_name") or "AI 小助手").strip()[:30]
    avatar = (cfg.get("ai_user_avatar") or "").strip()[:500]
    user = (await db.execute(select(User).where(User.is_bot.is_(True)).limit(1))).scalar_one_or_none()
    if not user:
        import secrets
        import uuid as _uuid
        from app.core.security import get_password_hash as hash_password
        user = User(
            id=_uuid.uuid4(),
            username="ai_companion",
            email="ai_companion@local.invalid",
            password_hash=hash_password(secrets.token_urlsafe(32)),
            nickname=name,
            avatar_url=avatar or None,
            role="user",
            status="active",
            is_bot=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        changed = False
        if name and user.nickname != name:
            user.nickname = name
            changed = True
        if avatar and user.avatar_url != avatar:
            user.avatar_url = avatar
            changed = True
        if changed:
            await db.commit()
    return user


def _plain_body(md: str) -> str:
    """把 Markdown 压成纯文本，减少图片/链接/HTML 噪声干扰模型。"""
    import re as _re

    text = md or ""
    text = _re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)          # 图片
    text = _re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)        # 链接 → 文字
    text = _re.sub(r"<[^>]{1,200}>", " ", text)                  # HTML 标签
    text = _re.sub(r"[`*_>#]{1,}", " ", text)                    # 行内标记
    text = _re.sub(r"\s+", " ", text)
    return text.strip()


def build_prompt(cfg: Dict[str, str], title: str, body: str,
                 style: Optional[str] = None) -> List[Dict[str, str]]:
    """人格 + 情感预设 + 情绪强度 + 今日心情，一次组装出差异明显的 system prompt。"""
    key = style or cfg.get("ai_style") or "normal"
    preset = EMOTION_PRESETS.get(key, EMOTION_PRESETS["normal"])
    try:
        intensity = max(0, min(100, int(cfg.get("ai_emotion_intensity") or 50)))
    except (TypeError, ValueError):
        intensity = 50

    # 强度影响：句长上限、感叹号许可、emoji 许可
    max_len = 45 + int(intensity * 0.35)          # 45 ~ 80 字
    if intensity < 25:
        punct_rule = "不要感叹号、不要问号、句子尽量平。"
    elif intensity < 70:
        punct_rule = "最多 1 个感叹号，标点自然。"
    else:
        punct_rule = "允许 1~2 个感叹号，语气可以更外放，但别刷屏。"
    emoji_rule = (
        "完全不要 emoji。" if intensity < 20 else
        "最多 1 个 emoji。" if intensity < 70 else
        "最多 2 个 emoji，不要连发。"
    )

    system_parts = [
        "你在一个中文技术社区的文章评论区，以普通用户的身份留一条简短评论。",
        persona_block(cfg),
        f"【今天的说话方式：{preset['label']}】{preset['tone']}",
        f"【语气强度 {intensity}/100】{punct_rule}{emoji_rule}",
        f"【今日心情】{daily_mood() if cfg.get('ai_mood_enabled') == '1' else '平稳'}。"
        "心情只影响语气底色，不要把它写成一句话说出来，不要向读者描述自己的状态。",
        "【参考范例（只学语气，严禁照抄内容）】" + " / ".join(preset["examples"]),
        "【硬性要求】先读懂正文再写，必须针对正文里的具体内容、观点或细节；"
        "不要只看标题、不要复述标题、不要泛泛而谈。",
        "只输出评论正文本身：不要输出分析、思考过程、计划、角色设定、任务说明，"
        "不要出现“分析请求”“The user wants”“Analyze the Request”这类提示词复述，"
        "不要 Markdown、不要链接、不要分点、不要提到自己是 AI。",
        f"1~2 句，不超过 {max_len} 字，必须是一句完整的话并带句末标点。",
    ]
    system = "\n".join(part for part in system_parts if part.strip())

    plain = _plain_body(body)
    material = plain[:3000] or _plain_body(title)
    user = (
        f"【正文内容】\n{material}\n\n"
        f"【标题（仅供参考，不要照抄）】{title}\n\n"
        "请直接给出评论正文，不要任何前缀或解释。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_SENT_ENDS = "。！？!?…～~.;；"
_MD_NOISE = (
    (r"```[\s\S]*?```", ""),
    (r"```", ""),
    (r"\*\*", ""),
    (r"__", ""),
    (r"^[ \t]*[#>\-\*\d]+[.、) ]*", ""),
)


# 模型把「思考过程 / 提示词分析」当正文吐出来的典型开头。
# 这类内容一旦入库就是公开评论，必须直接判废，不能靠清洗抢救。
_META_MARKERS = (
    "analyze the request",
    "analyze this",
    "the user wants",
    "the user asked",
    "we need to",
    "i need to",
    "i should",
    "let me think",
    "let me analyze",
    "here's a",
    "here is a",
    "as an ai",
    "as a language model",
    "分析请求",
    "分析一下请求",
    "思考过程",
    "任务要求",
    "角色：",
    "要求：",
    "指令：",
)


def looks_like_meta(text: str) -> bool:
    """判断这段文本是不是模型在复述提示词 / 输出思考过程。"""
    t = (text or "").strip().lower()
    if not t:
        return False
    head = t[:160]
    return any(m in head for m in _META_MARKERS)


def finalize_comment(raw: str, finish_reason: str = "", limit: int = 160) -> str:
    """把模型输出收成一句完整的话：清 Markdown、按句末标点收口。

    即使被 max_tokens 截断（finish_reason="length"），也只会停在完整句子处，
    不会出现「说到一半」的观感。识别到提示词复述则直接返回空串（判废）。
    """
    import re as _re

    text = (raw or "").strip()
    if not text:
        return ""
    for pat, rep in _MD_NOISE:
        text = _re.sub(pat, rep, text, flags=_re.MULTILINE | _re.DOTALL)
    text = _re.sub(r"\s+", " ", text).strip()
    # 去掉「评论：」「回复：」这类前缀，再判断是不是思考过程
    text = _re.sub(r"^(评论|回复|回答|Comment)\s*[:：]\s*", "", text, flags=_re.IGNORECASE)
    if not text or looks_like_meta(text):
        return ""

    truncated = finish_reason == "length" or len(text) > limit
    if len(text) > limit:
        text = text[:limit]
    if truncated:
        cut = max(text.rfind(ch) for ch in _SENT_ENDS)
        if cut >= max(12, int(len(text) * 0.4)):
            text = text[:cut + 1]
        else:
            text = text.rstrip("，,、 ：:；;") + "…"
    return text.strip()


# 这些错误属于「临时性」，不应该消耗帖子的重试次数（否则限流会把帖子标成放弃）
_TRANSIENT_ERRORS = ("429", "Too Many Requests", "timeout", "Timeout", "timed out",
                     "502", "503", "504", "ConnectError", "ReadTimeout")


def comment_is_acceptable(text: str) -> bool:
    """质量过滤：拒绝思考过程复述、英文跑偏、代码/链接片段。

    中文社区要求至少 6 个汉字。以前留了「9 个英文单词即通过」的后门，
    正是 "Analyze the Request: Role: ..." 这类内容能进评论区的原因。
    """
    t = (text or "").strip()
    if len(t) < 8 or len(t) > 200:
        return False
    if looks_like_meta(t):
        return False
    if "```" in t or "http://" in t or "https://" in t:
        return False
    cjk = sum(1 for ch in t if "\u4e00" <= ch <= "\u9fff")
    if cjk < 6:
        return False
    latin = sum(1 for ch in t if ch.isascii() and ch.isalpha())
    if latin > cjk * 3:
        return False
    return True


async def _generate_one(post_id: str, cfg: Dict[str, str], ai_user_id: str) -> bool:
    """处理单帖：占位已在批量抢锁阶段完成，这里只负责生成与落库。

    空内容 / 质量不合格会立即重试一次（换一次采样通常就好）。
    注意：模型返回的思考过程(errors)一律判废，绝不兜底成评论。
    """
    from datetime import datetime, timezone

    from sqlalchemy import text as _text

    from app.core.database import AsyncSessionLocal
    from app.models.comment import Comment
    from app.services.sensitive_service import sensitive_filter

    async with AsyncSessionLocal() as db:
        post = (await db.execute(
            _text("SELECT title, content_md FROM posts WHERE id = :pid"), {"pid": post_id}
        )).one_or_none()
        if not post:
            await db.execute(_text("UPDATE ai_comment_log SET last_error='帖子已不存在' WHERE post_id=:pid"),
                             {"pid": post_id})
            await db.commit()
            return False

        mode = (cfg.get("ai_reply_mode") or "hybrid").strip()
        phrases = reply_phrases(cfg)
        body, err, transient = "", "", False

        # fixed：管理员直接设定的回复语，不调模型（限流/无 Key 也能照常回复）
        if mode == "fixed" and phrases:
            import random as _random
            body = _random.choice(phrases)

        if mode != "fixed":
            for _attempt in range(2):
                try:
                    res = await chat_completion(cfg, build_prompt(cfg, post[0] or "", post[1] or ""))
                    candidate = finalize_comment(res.get("text", ""), res.get("finish_reason", ""))
                    if candidate and comment_is_acceptable(candidate):
                        # 与普通用户同口径：命中敏感词直接丢弃，替换型则用清洗后的文本
                        blocked, hits, cleaned = sensitive_filter.scan(candidate)
                        if blocked:
                            err = f"模型输出命中敏感词：{','.join(hits[:3])}"
                        else:
                            body = (cleaned or candidate).strip()
                            if comment_is_acceptable(body):
                                break
                            body = ""
                            err = "模型输出清洗后质量不合格"
                    else:
                        body = ""
                        err = "模型返回空内容或质量不合格（限流/小模型跑偏）"
                except Exception as exc:
                    err = str(exc)[:300]
                    transient = any(k in err for k in _TRANSIENT_ERRORS)
                    body = ""
                    if transient:
                        break

        # hybrid：模型失败时用管理员设定的回复语兜底，保证「自动去回复」不中断
        if not body and mode == "hybrid" and phrases:
            import random as _random
            body = _random.choice(phrases)
            err = ""
            transient = False

        if body:
            body = apply_fun(body, cfg)
            blocked, hits, cleaned = sensitive_filter.scan(body)
            if blocked:
                body, err = "", f"最终评论命中敏感词：{','.join(hits[:3])}"
            else:
                body = (cleaned or body).strip()

        if not body:
            if transient:
                # 限流 / 超时：退还本次尝试，下一轮继续，不把帖子判死刑
                await db.execute(
                    _text("UPDATE ai_comment_log "
                          "SET attempts = GREATEST(0, attempts - 1), last_error = :err "
                          "WHERE post_id = :pid"),
                    {"err": err or "未知错误", "pid": post_id},
                )
            else:
                await db.execute(
                    _text("UPDATE ai_comment_log SET last_error = :err WHERE post_id = :pid"),
                    {"err": err or "未知错误", "pid": post_id},
                )
            await db.commit()
            logger.warning("AI 生成评论失败 post=%s: %s", post_id, err)
            return False

        comment = Comment(
            post_id=post_id, author_id=ai_user_id, content=body,
            is_anonymous=False, status="visible", image_url=None,
            created_at=datetime.now(timezone.utc),
        )
        db.add(comment)
        await db.flush()
        await db.execute(
            _text("UPDATE ai_comment_log SET comment_id = :cid, last_error = NULL WHERE post_id = :pid"),
            {"cid": str(comment.id), "pid": post_id},
        )
        await db.execute(
            _text("UPDATE posts SET comment_count = COALESCE(comment_count, 0) + 1 WHERE id = :pid"),
            {"pid": post_id},
        )
        await db.commit()
        return True


# 自动评论的选帖口径：抢名额与统计必须共用，否则管理端进度和实际行为对不上
_AI_POST_FILTER_SQL = """
      p.status = 'published'
  AND p.post_type <> 'news'
  AND coalesce(length(p.content_md), 0) >= 80
  AND p.title NOT ILIKE '%日报%'
  AND p.title NOT ILIKE '%早报%'
  AND p.title NOT ILIKE '%周报%'
  AND NOT EXISTS (
        SELECT 1 FROM categories c
        WHERE c.id = p.category_id AND c.name = '新闻早报'
      )
"""

# 回补窗口：只看最近两周的帖子，避免把很久以前的旧帖重新翻出来评论
AI_COMMENT_WINDOW_DAYS = 14


async def _ai_commented_today(db: AsyncSession, ai_user_id: Any) -> int:
    """AI 机器人今天（东八区自然日）已经发了几条评论。"""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text as _text

    tz = timezone(timedelta(hours=8))
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    row = await db.execute(
        _text("SELECT count(*) FROM comments WHERE author_id = :aid AND created_at >= :start"),
        {"aid": str(ai_user_id), "start": start.astimezone(timezone.utc)},
    )
    return int(row.scalar_one() or 0)


async def auto_comment_recent(db: AsyncSession, max_posts: int = 1) -> int:
    """随机挑「从未被 AI 评论过」的帖子补一条评论，一帖恰好一条。

    设计取舍：
    1) 随机取样（ORDER BY random()），不再按时间从老到新巡检；
    2) 串行生成，多条之间随机停顿 —— 模型扛不住并发；
    3) 每日上限读 ai_daily_limit（此前只有配置项，代码里从未生效）；
    4) 跳过日报/早报/周报、新闻早报分类、正文过短的帖子；
    5) 成功写 comment_id（永不再生成）；失败记 last_error，满 3 次放弃，
       限流/超时退还次数，下一轮继续；
    6) 本函数是「兜底补评」，额度读 ai_daily_limit；新帖即时回复走
       auto_comment_post，另有 2 倍硬熔断上限，两者互不挤占。
    """
    import asyncio
    import random
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text as _text

    cfg = await load_ai_config(db)
    if cfg.get("ai_enabled") != "1" or cfg.get("ai_auto_comment") != "1":
        return 0
    if not (cfg.get("ai_api_key") and cfg.get("ai_model") and cfg.get("ai_base_url")):
        return 0

    ai_user = await get_ai_user(db, cfg)
    if not ai_user:
        return 0

    try:
        daily_limit = int(cfg.get("ai_daily_limit") or 0)
    except (TypeError, ValueError):
        daily_limit = 0
    if daily_limit <= 0:
        daily_limit = 50

    # 与即时触发共用同一套额度，避免「即时触发失败后兜底也哑火」：
    # ai_daily_limit 是基础额度，实际硬上限取 2 倍且不低于 100。
    hard_limit = max(100, daily_limit * 2)
    used_today = await _ai_commented_today(db, ai_user.id)
    remaining = hard_limit - used_today
    if remaining <= 0:
        logger.info("[AI] 今日评论达硬上限 %s/%s（基础额度 %s），本轮跳过",
                    used_today, hard_limit, daily_limit)
        return 0

    limit = max(1, min(int(max_posts), remaining))
    since = datetime.now(timezone.utc) - timedelta(days=AI_COMMENT_WINDOW_DAYS)
    claimed = (await db.execute(_text(
        f"""
        INSERT INTO ai_comment_log (post_id, attempts)
        SELECT p.id, 1 FROM posts p
        WHERE {_AI_POST_FILTER_SQL}
          AND p.created_at >= :since
          AND NOT EXISTS (
            SELECT 1 FROM ai_comment_log l
            WHERE l.post_id = p.id AND (l.comment_id IS NOT NULL OR l.attempts >= 3)
          )
        ORDER BY random()
        LIMIT :lim
        ON CONFLICT (post_id) DO UPDATE SET attempts = ai_comment_log.attempts + 1
          WHERE ai_comment_log.comment_id IS NULL AND ai_comment_log.attempts < 3
        RETURNING post_id
        """
    ), {"since": since, "lim": limit})).all()
    await db.commit()

    ids = [str(r[0]) for r in claimed]
    if not ids:
        return 0

    # 串行 + 全局缓冲：和「上一条 AI 回复」拉开间隔，防止高频调用返回空结果
    ok = 0
    for pid in ids:
        await _apply_reply_buffer(db, cfg, ai_user.id)
        if await _generate_one(pid, cfg, str(ai_user.id)):
            ok += 1
    return ok


async def ai_comment_stats(db: AsyncSession) -> Dict[str, Any]:
    """AI 评论进度：总数 / 已评 / 待评 / 已放弃，供管理端展示。"""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text as _text

    since = datetime.now(timezone.utc) - timedelta(days=AI_COMMENT_WINDOW_DAYS)
    row = (await db.execute(_text(
        f"""
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE l.comment_id IS NOT NULL) AS done,
          count(*) FILTER (WHERE l.comment_id IS NULL AND l.attempts >= 3) AS failed,
          count(*) FILTER (WHERE l.comment_id IS NULL AND l.attempts < 3) AS in_flight
        FROM posts p
        LEFT JOIN ai_comment_log l ON l.post_id = p.id
        WHERE {_AI_POST_FILTER_SQL}
          AND p.created_at >= :since
        """
    ), {"since": since})).one()
    total, done, failed, in_flight = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0), int(row[3] or 0)
    return {
        "window_days": AI_COMMENT_WINDOW_DAYS,
        "total": total, "done": done, "failed": failed,
        "pending": max(0, total - done - failed),
        "in_flight": in_flight,
    }


async def _seconds_since_last_ai_comment(db: AsyncSession, ai_user_id: Any) -> Optional[float]:
    """距上一条 AI 评论过了多少秒。用于全局缓冲，避免短时间内连打模型。"""
    from datetime import datetime, timezone

    from sqlalchemy import text as _text

    row = (await db.execute(_text(
        "SELECT max(created_at) FROM comments WHERE author_id = :aid AND status = 'visible'"
    ), {"aid": str(ai_user_id)})).scalar_one_or_none()
    if not row:
        return None
    if getattr(row, "tzinfo", None) is None:
        row = row.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - row).total_seconds()


async def _apply_reply_buffer(db: AsyncSession, cfg: Dict[str, str], ai_user_id: Any) -> None:
    import asyncio
    import random

    try:
        buf = max(0, min(120, int(cfg.get("ai_reply_buffer_sec") or 20)))
    except (TypeError, ValueError):
        buf = 20
    elapsed = await _seconds_since_last_ai_comment(db, ai_user_id)
    if elapsed is not None and elapsed < buf:
        # 加一点抖动，避免多个 worker 同时唤醒
        await asyncio.sleep(buf - elapsed + random.uniform(0.5, 2.5))


async def auto_comment_post(db: AsyncSession, post_id: str) -> bool:
    """对「一条刚发布的新帖」立即评论一次（新闻早报类除外）。

    与 auto_comment_recent 共用 ai_comment_log 主键占位，保证一帖一条：
    发帖即时触发和 5 分钟兜底扫描同时命中也不会重复。
    """
    from sqlalchemy import text as _text

    cfg = await load_ai_config(db)
    if cfg.get("ai_enabled") != "1" or cfg.get("ai_auto_comment") != "1":
        return False
    if not (cfg.get("ai_api_key") and cfg.get("ai_model") and cfg.get("ai_base_url")):
        return False

    # 过滤口径与兜底扫描一致：已发布 / 非日报早报 / 非新闻分类 / 正文够长
    exists = (await db.execute(_text(
        f"SELECT 1 FROM posts p WHERE p.id = :pid AND {_AI_POST_FILTER_SQL}"
    ), {"pid": post_id})).scalar_one_or_none()
    if not exists:
        return False

    ai_user = await get_ai_user(db, cfg)
    if not ai_user:
        return False

    try:
        daily_limit = int(cfg.get("ai_daily_limit") or 0) or 50
    except (TypeError, ValueError):
        daily_limit = 50

    # 新帖即时回复优先级最高：ai_daily_limit 是「兜底补评」额度，
    # 历史补漏把它吃光后不应该让新帖整天没有回复。
    # 这里改用 2 倍额度（且不低于 100）作为硬熔断，仅用于防止异常刷屏。
    hard_limit = max(100, daily_limit * 2)
    used_today = await _ai_commented_today(db, ai_user.id)
    if used_today >= hard_limit:
        logger.info(
            "[AI] 今日评论达硬上限 %s/%s（补评额度 %s），跳过即时触发",
            used_today, hard_limit, daily_limit,
        )
        return False

    claimed = (await db.execute(_text(
        """
        INSERT INTO ai_comment_log (post_id, attempts) VALUES (:pid, 1)
        ON CONFLICT (post_id) DO UPDATE SET attempts = ai_comment_log.attempts + 1
          WHERE ai_comment_log.comment_id IS NULL AND ai_comment_log.attempts < 3
        RETURNING post_id
        """
    ), {"pid": post_id})).scalar_one_or_none()
    await db.commit()
    if not claimed:
        return False

    # 缓冲：与最近一条 AI 回复拉开间隔，防止高频调用拿到空结果
    await _apply_reply_buffer(db, cfg, ai_user.id)
    return await _generate_one(post_id, cfg, str(ai_user.id))


# 强引用集合：防止 create_task 的任务被 GC 提前回收（仿 image_service 的范式）
_AI_TRIGGER_TASKS: set = set()


def schedule_ai_comment(post_id: str) -> None:
    """发帖接口里调用：不阻塞响应，异步给这条新帖补一条 AI 评论。"""
    import asyncio

    from app.core.database import AsyncSessionLocal

    async def runner() -> None:
        try:
            async with AsyncSessionLocal() as db:
                await auto_comment_post(db, post_id)
        except Exception:
            logger.exception("[AI] 即时评论任务异常 post=%s", post_id)

    try:
        task = asyncio.create_task(runner())
        _AI_TRIGGER_TASKS.add(task)
        task.add_done_callback(_AI_TRIGGER_TASKS.discard)
    except RuntimeError:
        # 无事件循环（同步上下文）时静默跳过，由 5 分钟兜底任务补上
        logger.debug("[AI] 无事件循环，跳过即时触发 post=%s", post_id)


async def ai_daily_digest(db: AsyncSession) -> Dict[str, Any]:
    """统计 AI 今天（东八区）回复了多少条帖子，并挑一条「今日金句」。"""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import text as _text

    tz = timezone(timedelta(hours=8))
    start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    rows = (await db.execute(_text(
        """
        SELECT c.content, c.created_at, p.title
        FROM comments c
        JOIN users u ON u.id = c.author_id
        LEFT JOIN posts p ON p.id = c.post_id
        WHERE u.is_bot = TRUE AND c.status = 'visible' AND c.created_at >= :start
        ORDER BY c.created_at DESC
        """
    ), {"start": start})).all()

    count = len(rows)
    best = ""
    if rows:
        # 金句评分：有 emoji / 感叹号 / 问号的更有趣，长度适中优先
        def score(row):
            t = row[0] or ""
            return (sum(t.count(ch) for ch in "！？!?…😂🎉🔪🫶🌙❓🔍") * 3
                    + min(len(t), 60) / 20)
        best = (max(rows, key=score)[0] or "").strip()[:80]

    return {
        "date": datetime.now(tz).date().isoformat(),
        "count": count,
        "best": best,
        "mood": daily_mood(),
        "failures": int((await db.execute(_text(
            "SELECT count(*) FROM ai_comment_log WHERE last_error IS NOT NULL "
            "AND comment_id IS NULL AND created_at >= :start"
        ), {"start": start})).scalar_one() or 0),
    }
