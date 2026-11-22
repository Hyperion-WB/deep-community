"""成语接龙裁判：基于 crazywhalecc/idiom-database 的完整词库，支持同音接龙。

数据源：https://github.com/crazywhalecc/idiom-database （data/idiom.json）
用词条自带的 first / last 无调拼音（如「阿鼻地狱」first=a, last=yu），
生成按首字读音分组的索引 app/data/idioms.json（懒加载）。

校验规则（同音即可，不要求同一个字）：
1) 必须是词库中的合法四字成语；
2) 首字读音必须与上一成语末字读音相同（同音不同字也算通过）；
3) 本局不能重复使用；
4) 机器人接回时优先选「末字读音仍有后继」的成语，避免一步走死。
"""
import json
import random
import re
from pathlib import Path
from typing import Dict, List, Optional, Set

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "idioms.json"

_SOUNDS: Optional[Dict[str, List[str]]] = None   # 首字读音 → 成语列表
_LAST: Optional[Dict[str, str]] = None           # 成语 → 末字读音
_FIRST: Optional[Dict[str, str]] = None          # 成语 → 首字读音（运行时反推）
_ALL_WORDS: Optional[Set[str]] = None
_STARTERS: Optional[List[str]] = None

_SOUND_RE = re.compile(r"^[a-z]+$")


def _load() -> None:
    global _SOUNDS, _LAST, _FIRST, _ALL_WORDS, _STARTERS
    if _SOUNDS is not None:
        return
    with open(_DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    _SOUNDS = data.get("sounds") or {}
    _LAST = data.get("last") or {}
    _FIRST = {w: sound for sound, words in _SOUNDS.items() for w in words}
    _ALL_WORDS = set(_LAST.keys())
    # 开局成语：末字读音也要有可接的词，避免开局即死局
    _STARTERS = [w for w in _ALL_WORDS
                 if any(cand != w for cand in (_SOUNDS or {}).get(_LAST[w], []))]


def stats() -> Dict[str, int]:
    _load()
    return {"words": len(_ALL_WORDS or ()), "sounds": len(_SOUNDS or ()),
            "starters": len(_STARTERS or ()), "mode": 1}  # mode=1 同音模式


def is_valid(word: str) -> bool:
    _load()
    return (word or "").strip() in (_LAST or {})


def tail_char(word: str) -> str:
    return (word or "").strip()[-1:]


def head_char(word: str) -> str:
    return (word or "").strip()[:1]


def tail_sound(word: str) -> str:
    """末字读音（无调拼音），用于同音接龙。"""
    _load()
    return (_LAST or {}).get((word or "").strip(), "")


def head_sound(word: str) -> str:
    _load()
    return (_FIRST or {}).get((word or "").strip(), "")


def sound_hint(word: str) -> str:
    """给玩家看的提示：末字 + 读音，如「木 (mu)」。"""
    s = tail_sound(word)
    return f"{tail_char(word)}（{s}）" if s else tail_char(word)


def next_count(word: str) -> int:
    _load()
    return len([w for w in (_SOUNDS or {}).get(tail_sound(word), []) if w != word])


def has_successor(word: str) -> bool:
    return next_count(word) > 0


def check_answer(word: str, current_sound: str, used: List[str]) -> tuple:
    """返回 (是否通过, 原因)。current_sound 是上一成语末字的读音；
    兼容旧局传入汉字（此时退化成严格同字判定）。"""
    w = (word or "").strip()
    if len(w) != 4:
        return False, "请输入四个字的成语"
    if not is_valid(w):
        return False, f"「{w}」不在成语词库中，换个试试"
    if w in used:
        return False, f"「{w}」本局已经用过啦"

    sound = (current_sound or "").strip().lower()
    if not _SOUND_RE.match(sound):
        # 旧局 / 兜底：按同字判定
        if head_char(w) != sound[:1]:
            return False, f"要以「{sound[:1]}」开头，你接的是「{head_char(w)}」"
        return True, ""

    got = head_sound(w)
    if got != sound:
        return False, (f"要接读音「{sound}」的字，你接的「{head_char(w)}」读音是「{got or '未知'}」，"
                       f"同音不同字也可以哦")
    return True, ""


def bot_next(sound: str, used: List[str]) -> Optional[str]:
    """机器人接词：按读音找候选，优先挑「末字读音仍有后继」的，避免死局。"""
    _load()
    pool = [w for w in (_SOUNDS or {}).get((sound or "").strip().lower(), []) if w not in used]
    if not pool:
        return None
    alive = [w for w in pool if has_successor(w)]
    return random.choice(alive or pool)


def pick_start() -> str:
    _load()
    return random.choice(_STARTERS or sorted(_ALL_WORDS or []))
