#!/usr/bin/env python3
"""飞花令词库构建：把 chinese-poetry 的多套诗词集合并成 poetry.db。

数据来源（均为开源）：https://github.com/chinese-poetry/chinese-poetry
覆盖：全唐诗（唐）、宋词、五代诗词（花间集/南唐）、诗经、楚辞、元曲、纳兰性德、曹操诗集、水墨唐诗；
可选 --include-song 追加「全宋诗」（约 25 万首，词库会明显变大，默认关闭）。

用法：
  # 1) 准备数据（稀疏克隆，只拉需要的目录）
  git clone --depth 1 --filter=blob:none --sparse https://github.com/chinese-poetry/chinese-poetry.git /tmp/cp
  cd /tmp/cp && git sparse-checkout set 全唐诗 宋词 五代诗词 诗经 楚辞 元曲 纳兰性德 曹操诗集 水墨唐诗

  # 2) 繁简转换依赖（构建期用，服务器运行时不依赖）
  pip install zhconv

  # 3) 构建
  python3 scripts/import_poetry.py --src /tmp/cp --out backend/app/data/poetry.db
  python3 scripts/import_poetry.py --src /tmp/cp --out /tmp/poetry-song.db --include-song   # 含全宋诗

产出表：
  works(id INTEGER PK, info TEXT UNIQUE)        出处，如「李白《静夜思》」
  verses(verse TEXT PK, work_id INTEGER)        去重后的短句（统一简体）
  flags(flag TEXT PK, cnt INTEGER)              可用令字及句数
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

try:
    import zhconv  # 繁体 → 简体
except ImportError:
    zhconv = None

# 诗/词/曲里可作正文的字段（notes/intro/prologue 之类是注释，不能当诗句）
TEXT_FIELDS = ("paragraphs", "para", "content")
# 断句标点：中英文都切
SPLIT_RE = re.compile(r"[，。！？；：、,.!?;:\s]+")
HAN_RE = re.compile(r"^[\u4e00-\u9fff]+$")

# 补充句库（汉魏六朝、常见宋诗、教材版名句），chinese-poetry 没有覆盖
DEFAULT_EXTRA = Path(__file__).resolve().parent.parent / "backend" / "app" / "data" / "feihua_extra.json"

MIN_LEN = 4
# 飞花令答案基本都是五言/七言，长句多为曲白或词中长调，收进库只会让词库变胖
MAX_LEN = 12

# 令字黑名单：纯虚词/数词，抽到「不/之/一/有」体验极差
FLAG_BLACKLIST = set(
    "不之以为而于所与者也矣乎哉其此彼亦又且但只更最很都还就才已曾"
    "上下中里外来去有无一二三四五六七八九十百千万我汝尔何如若似是"
    "非在所能如似可欲应将须莫勿休且但只更最又亦"
)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"  ! 跳过无法解析的文件 {os.path.basename(path)}: {exc}", file=sys.stderr)
        return None


def conv(text):
    """繁体转简体（zu 变体差异也一并归一）。"""
    if zhconv is None:
        return text
    return zhconv.convert(text, "zh-cn")


def split_verses(text, out):
    """把「句，句。」切成 4~16 字的纯汉字短句。"""
    if not text:
        return
    for part in SPLIT_RE.split(text):
        s = part.strip()
        if not (MIN_LEN <= len(s) <= MAX_LEN):
            continue
        if not HAN_RE.match(s):
            continue
        out.append(s)


def make_info(rec, kind):
    author = (rec.get("author") or "").strip()
    title = (rec.get("title") or rec.get("rhythmic") or "").strip()
    if kind == "shijing":
        chapter = (rec.get("chapter") or "").strip()
        section = (rec.get("section") or "").strip()
        title = (rec.get("title") or "").strip()
        parts = [p for p in (chapter, section, title) if p]
        return "《诗经·" + "·".join(parts) + "》" if parts else "《诗经》"
    if kind == "chuci":
        return f"{author}《{title}》" if author else f"《楚辞·{title}》"
    if not title:
        return author or "佚名"
    return f"{author}《{title}》" if author else f"《{title}》"


def iter_dataset(src, include_song):
    """产出 (records, kind, dataset_label)。"""
    tang = sorted(glob.glob(os.path.join(src, "全唐诗", "poet.tang.*.json")))
    song = sorted(glob.glob(os.path.join(src, "全唐诗", "poet.song.*.json")))
    ci = sorted(glob.glob(os.path.join(src, "宋词", "ci.song.*.json")))
    shijing = os.path.join(src, "诗经", "shijing.json")
    chuci = os.path.join(src, "楚辞", "chuci.json")
    yuanqu = os.path.join(src, "元曲", "yuanqu.json")
    nalan = os.path.join(src, "纳兰性德", "纳兰性德诗集.json")
    caocao = os.path.join(src, "曹操诗集", "caocao.json")
    shuimo = os.path.join(src, "水墨唐诗", "shuimotangshi.json")
    huajian = sorted(glob.glob(os.path.join(src, "五代诗词", "huajianji", "*.json")))
    nantang = os.path.join(src, "五代诗词", "nantang", "poetrys.json")

    groups = [
        ("tang", "全唐诗", tang),
        ("ci", "宋词", ci),
        ("huajianji", "花间集", huajian),
        ("nantang", "南唐词", [nantang] if os.path.exists(nantang) else []),
        ("shijing", "诗经", [shijing] if os.path.exists(shijing) else []),
        ("chuci", "楚辞", [chuci] if os.path.exists(chuci) else []),
        ("yuanqu", "元曲", [yuanqu] if os.path.exists(yuanqu) else []),
        ("nalan", "纳兰性德", [nalan] if os.path.exists(nalan) else []),
        ("caocao", "曹操诗集", [caocao] if os.path.exists(caocao) else []),
        ("shuimo", "水墨唐诗", [shuimo] if os.path.exists(shuimo) else []),
    ]
    if include_song:
        groups.insert(1, ("song", "全宋诗", song))
    else:
        print(f"  全宋诗：跳过 {len(song)} 个文件（加 --include-song 可收录）")

    for kind, label, paths in groups:
        yield kind, label, paths


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/tmp/cp", help="chinese-poetry 仓库目录")
    ap.add_argument("--out", default="backend/app/data/poetry.db", help="输出 SQLite 路径")
    ap.add_argument("--include-song", action="store_true", help="收录全宋诗（约 25 万首，体积翻倍）")
    ap.add_argument("--min-flag-count", type=int, default=200, help="令字最少可用句数")
    ap.add_argument("--extra", default=str(DEFAULT_EXTRA), help="补充句库 JSON（默认 backend/app/data/feihua_extra.json）")
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        sys.exit(f"找不到数据目录：{args.src}")
    if zhconv is None:
        print("警告：未安装 zhconv，繁体诗句不会转简体（pip install zhconv）", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if os.path.exists(args.out):
        os.remove(args.out)

    db = sqlite3.connect(args.out)
    cur = db.cursor()
    # WITHOUT ROWID：诗句文本本身就是主键，省掉一整棵隐式索引（80 万行约省 10MB+）
    cur.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = OFF;
        CREATE TABLE works (id INTEGER PRIMARY KEY, info TEXT);
        CREATE TABLE verses (verse TEXT PRIMARY KEY, work_id INTEGER) WITHOUT ROWID;
        CREATE TABLE flags (flag TEXT PRIMARY KEY, cnt INTEGER) WITHOUT ROWID;
        """
    )

    work_ids = {}
    seen_verses = set()
    char_counter = Counter()
    total_lines = 0
    total_verses = 0

    for kind, label, paths in iter_dataset(args.src, args.include_song):
        if not paths:
            print(f"  {label}: 无文件，跳过")
            continue
        cnt_before = len(seen_verses)
        for path in paths:
            data = load_json(path)
            if not isinstance(data, list):
                continue
            for rec in data:
                if not isinstance(rec, dict):
                    continue
                # 前言/导读类文件没有正文，跳过
                if "preface" in os.path.basename(path).lower():
                    continue
                info = conv(make_info(rec, kind))
                lines = []
                for field in TEXT_FIELDS:
                    val = rec.get(field)
                    if isinstance(val, list):
                        for item in val:
                            if isinstance(item, str):
                                split_verses(conv(item), lines)
                    elif isinstance(val, str):
                        split_verses(conv(val), lines)
                if not lines:
                    continue
                wid = work_ids.get(info)
                if wid is None:
                    cur.execute("INSERT INTO works(info) VALUES(?)", (info,))
                    wid = cur.lastrowid
                    work_ids[info] = wid
                total_lines += len(lines)
                for verse in lines:
                    if verse in seen_verses:
                        continue
                    seen_verses.add(verse)
                    cur.execute("INSERT OR IGNORE INTO verses(verse, work_id) VALUES(?,?)", (verse, wid))
                    for ch in verse:
                        char_counter[ch] += 1
        total_verses = len(seen_verses)
        print(f"  {label}: +{total_verses - cnt_before} 句（累计 {total_verses}）")

    # 补充句库：教材版名句、汉魏六朝诗等 chinese-poetry 未覆盖的句子
    if args.extra and os.path.exists(args.extra):
        extra = load_json(args.extra) or {}
        added_extra = 0
        for rec in extra.get("verses", []):
            if not isinstance(rec, dict):
                continue
            verse = conv(str(rec.get("verse") or "")).strip()
            info = conv(str(rec.get("info") or "")).strip()
            if not (MIN_LEN <= len(verse) <= MAX_LEN) or not HAN_RE.match(verse):
                continue
            if verse in seen_verses:
                continue
            wid = work_ids.get(info)
            if wid is None:
                cur.execute("INSERT INTO works(info) VALUES(?)", (info,))
                wid = cur.lastrowid
                work_ids[info] = wid
            seen_verses.add(verse)
            cur.execute("INSERT OR IGNORE INTO verses(verse, work_id) VALUES(?,?)", (verse, wid))
            for ch in verse:
                char_counter[ch] += 1
            added_extra += 1
        total_verses = len(seen_verses)
        print(f"  补充句库: +{added_extra} 句（累计 {total_verses}）")
    else:
        print(f"  补充句库：未找到 {args.extra}，跳过")

    flags = [
        (ch, n)
        for ch, n in char_counter.items()
        if n >= args.min_flag_count and ch not in FLAG_BLACKLIST and HAN_RE.match(ch)
    ]
    flags.sort(key=lambda x: -x[1])
    cur.executemany("INSERT OR REPLACE INTO flags(flag, cnt) VALUES(?,?)", flags)

    db.commit()
    cur.execute("CREATE INDEX idx_verses_work ON verses(work_id)")
    cur.execute("ANALYZE")
    cur.execute("VACUUM")
    db.commit()
    db.close()

    size_mb = os.path.getsize(args.out) / 1024 / 1024
    print("\n=== 构建完成 ===")
    print(f"作品数: {len(work_ids)} | 原始短句: {total_lines} | 去重后: {total_verses}")
    print(f"可用令字: {len(flags)}（≥{args.min_flag_count} 句）")
    print(f"输出: {args.out} ({size_mb:.1f} MB)")
    print("Top 20 令字:", " ".join(f"{c}{n}" for c, n in flags[:20]))


if __name__ == "__main__":
    main()
