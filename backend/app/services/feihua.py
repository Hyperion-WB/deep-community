"""飞花令裁判：诗库校验 + 令字抽取。

词库由 scripts/import_poetry.py 从 chinese-poetry 合并生成（只读 SQLite）：
  works(id, info)                 出处，如「李白《静夜思》」
  verses(verse TEXT PK, work_id)  去重后的短句（简体）
  flags(flag TEXT PK, cnt)        可用令字及句数

校验四关与开源实现一致：长度 4~16、必须含令字、局内不重复、必须在诗库中。
自选令字若不在诗库（如「雪」只有少量或没有），自动降级为宽松模式：只校验长度与含字。
"""
from __future__ import annotations

import random
import re
import sqlite3
import threading
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "poetry.db"

MIN_LEN = 4
MAX_LEN = 16

# 抽签优先出的意象字（按体验挑选，不按词频），顺序即展示顺序
PREFERRED_FLAGS = (
    "月", "花", "风", "水", "云", "山", "天", "春", "日", "心",
    "人", "酒", "江", "秋", "夜", "雨", "雪", "柳", "烟", "梦",
    "君", "梅", "竹", "松", "鹤", "雁", "舟", "海", "星", "露",
)

_PUNCT_RE = re.compile(r"[\s，。！？；：、,.!?;:\"'“”‘’（）()《》〈〉…—\-·]+")

_LOCK = threading.Lock()
_CONN: Optional[sqlite3.Connection] = None
_FLAG_COUNTS: Optional[Dict[str, int]] = None
_FLAG_LIST: Optional[List[Tuple[str, int]]] = None


def normalize(text: str) -> str:
    """去空白与标点，只留正文（用户可能粘贴「，」或带书名号）。"""
    return _PUNCT_RE.sub("", (text or "").strip())


def _db() -> Optional[sqlite3.Connection]:
    global _CONN
    if _CONN is not None:
        return _CONN
    if not _DB_PATH.exists():
        return None
    try:
        _CONN = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        _CONN.row_factory = sqlite3.Row
    except Exception:
        _CONN = None
    return _CONN


def _load_flags() -> List[Tuple[str, int]]:
    """令字 → 可用句数，按句数降序；结果进程内缓存。"""
    global _FLAG_COUNTS, _FLAG_LIST
    if _FLAG_LIST is not None:
        return _FLAG_LIST
    rows: List[Tuple[str, int]] = []
    conn = _db()
    if conn is not None:
        try:
            with _LOCK:
                rows = [(r["flag"], int(r["cnt"])) for r in conn.execute("SELECT flag, cnt FROM flags")]
        except Exception:
            rows = []
    counts = {f: c for f, c in rows}
    # 白名单字即便词库统计缺失也允许（宽松模式），排在前面
    ordered = [(f, counts.get(f, 0)) for f in PREFERRED_FLAGS]
    rest = sorted(((f, c) for f, c in rows if f not in PREFERRED_FLAGS), key=lambda x: -x[1])
    _FLAG_COUNTS = counts
    _FLAG_LIST = ordered + rest
    return _FLAG_LIST


def flag_count(flag: str) -> int:
    _load_flags()
    return (_FLAG_COUNTS or {}).get(flag, 0)


def available_flags(limit: int = 60) -> List[Dict[str, object]]:
    """前端令字面板：优先意象字，其余按句数降序。"""
    return [{"flag": f, "cnt": c} for f, c in _load_flags()[:limit]]


def random_flag() -> str:
    """随机令字：只从白名单里抽，且该字在词库中至少有一句。"""
    usable = [f for f in PREFERRED_FLAGS if flag_count(f) > 0]
    return random.choice(usable or list(PREFERRED_FLAGS))


def lookup(verse: str) -> Optional[str]:
    """诗句 → 出处；不在词库返回 None。"""
    conn = _db()
    if conn is None:
        return None
    try:
        with _LOCK:
            row = conn.execute(
                "SELECT w.info FROM verses v JOIN works w ON w.id = v.work_id WHERE v.verse = ? LIMIT 1",
                (verse,),
            ).fetchone()
        return row["info"] if row else None
    except Exception:
        return None


def resolve_mode(flag: str, requested: str = "auto") -> str:
    """strict（必须在诗库）/ loose（只校验含字）。

    auto：该令字在词库里有足够句子时用 strict，否则自动降级为 loose，
    这样自选「雪」「蝉」这类冷门字也能正常玩。
    """
    mode = (requested or "auto").lower()
    if mode in ("strict", "loose"):
        return mode
    return "strict" if flag_count(flag) >= 50 else "loose"


def validate(raw_verse: str, flag: str, mode: str = "auto") -> Tuple[bool, str, str, str]:
    """校验一句飞花令。

    返回 (是否通过, 失败原因, 归一化后的诗句, 出处)
    """
    verse = normalize(raw_verse)
    if not flag:
        return False, "本局还没有令字", verse, ""
    if len(verse) < MIN_LEN or len(verse) > MAX_LEN:
        return False, f"诗句需 {MIN_LEN}~{MAX_LEN} 字", verse, ""
    if flag not in verse:
        return False, f"诗句里没有「{flag}」", verse, ""

    effective = resolve_mode(flag, mode)
    if effective == "loose":
        return True, "", verse, ""
    info = lookup(verse)
    if not info:
        return False, "诗库里没有收录这句", verse, ""
    return True, "", verse, info


def stats() -> Dict[str, object]:
    """词库规模（后台/面板展示用）。"""
    conn = _db()
    if conn is None:
        return {"available": False, "verses": 0, "works": 0, "flags": 0, "path": str(_DB_PATH)}
    try:
        with _LOCK:
            verses = conn.execute("SELECT COUNT(*) AS n FROM verses").fetchone()["n"]
            works = conn.execute("SELECT COUNT(*) AS n FROM works").fetchone()["n"]
            flags = conn.execute("SELECT COUNT(*) AS n FROM flags").fetchone()["n"]
        return {"available": True, "verses": int(verses), "works": int(works), "flags": int(flags), "path": str(_DB_PATH)}
    except Exception:
        return {"available": False, "verses": 0, "works": 0, "flags": 0, "path": str(_DB_PATH)}
