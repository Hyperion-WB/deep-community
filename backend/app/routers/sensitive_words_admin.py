"""敏感词库管理（仅超级管理员可见可用）。

词库是运行时热加载的 Trie：写入数据库后立即触发一次 reload，
无需重启服务；调度器另有每 10 分钟兜底重载，覆盖多 worker 场景。
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.timezone import utc_now
from app.models.system import SensitiveWord
from app.models.user import User
from app.routers.deps import get_current_root_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["敏感词管理"])

VALID_SENSITIVE_ACTIONS = {"block", "replace", "warn"}


class SensitiveWordItem(BaseModel):
    word: str = Field(..., min_length=1, max_length=100)
    category: str = Field("general", max_length=50)
    action: str = Field("block", pattern="^(block|replace|warn)$")


class SensitiveWordBatch(BaseModel):
    words: list[SensitiveWordItem]


class SensitiveWordUpdate(BaseModel):
    word: Optional[str] = Field(None, min_length=1, max_length=100)
    category: Optional[str] = Field(None, max_length=50)
    action: Optional[str] = Field(None, pattern="^(block|replace|warn)$")


class SensitiveWordBulkDelete(BaseModel):
    ids: list[int]


def _normalize_word_item(raw: dict) -> Optional[dict]:
    # 统一小写入库：Trie 匹配本就忽略大小写，避免 ABC/abc 两条冗余记录
    word = str(raw.get("word") or "").strip().lower()
    if not word or len(word) > 100:
        return None
    action = str(raw.get("action") or "block").strip().lower()
    if action not in VALID_SENSITIVE_ACTIONS:
        action = "block"
    category = (str(raw.get("category") or "general").strip() or "general")[:50]
    return {"word": word, "action": action, "category": category}


def _parse_sensitive_import(text_data: str) -> list[dict]:
    """支持 JSON（字符串数组 / 对象数组 / {words:[...]}）、TXT、CSV（逗号或制表符）。"""
    stripped = (text_data or "").strip()
    if not stripped:
        return []

    parsed = None
    if stripped[0] in "[{":
        try:
            parsed = json.loads(stripped)
        except Exception:
            parsed = None

    if isinstance(parsed, dict):
        parsed = parsed.get("words") or parsed.get("items") or parsed.get("data") or []

    items: list[dict] = []
    if isinstance(parsed, list):
        for entry in parsed:
            if isinstance(entry, str):
                item = _normalize_word_item({"word": entry})
            elif isinstance(entry, dict):
                item = _normalize_word_item(entry)
            else:
                item = None
            if item:
                items.append(item)
        return items

    for line in stripped.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "\t" in line:
            parts = [p.strip() for p in line.split("\t")]
        elif "," in line:
            parts = [p.strip() for p in line.split(",")]
        else:
            parts = [line]
        item = _normalize_word_item({
            "word": parts[0],
            "category": parts[1] if len(parts) > 1 else "general",
            "action": parts[2] if len(parts) > 2 else "block",
        })
        if item:
            items.append(item)
    return items


def _dedupe_words(items: list[dict]) -> list[dict]:
    seen: set[str] = set()
    result: list[dict] = []
    for item in items:
        key = item["word"].lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


async def _reload_sensitive_now() -> None:
    try:
        from app.tasks.scheduler import reload_sensitive_words
        await reload_sensitive_words()
    except Exception as exc:  # noqa: BLE001
        logger.warning("敏感词热重载失败（调度器将在 1 分钟内兜底重载）: %s", exc)


async def _insert_words(db: AsyncSession, items: list[dict]) -> int:
    """分批插入（每批 1000），避免大词库一次绑定过多 SQL 参数触发 PG 上限。"""
    now = utc_now()
    inserted = 0
    for start in range(0, len(items), 1000):
        chunk = items[start:start + 1000]
        stmt = pg_insert(SensitiveWord).values(
            [{**item, "created_at": now} for item in chunk]
        ).on_conflict_do_nothing(index_elements=["word"])
        result = await db.execute(stmt)
        inserted += result.rowcount or 0
    await db.commit()
    await _reload_sensitive_now()
    return inserted


@router.get("/sensitive-words")
async def list_sensitive_words(
    q: Optional[str] = None,
    action: Optional[str] = Query(None, pattern="^(block|replace|warn)$"),
    page: int = Query(1, ge=1),
    size: int = Query(50, ge=1, le=200),
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    conditions = []
    if q and q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        conditions.append(SensitiveWord.word.ilike(f"%{escaped}%", escape="\\"))
    if action:
        conditions.append(SensitiveWord.action == action)

    total = (await db.execute(
        select(func.count(SensitiveWord.id)).where(*conditions)
    )).scalar_one()
    rows = (await db.execute(
        select(SensitiveWord)
        .where(*conditions)
        .order_by(SensitiveWord.created_at.desc(), SensitiveWord.id.desc())
        .offset((page - 1) * size)
        .limit(size)
    )).scalars().all()

    return {
        "total": int(total or 0),
        "page": page,
        "size": size,
        "items": [
            {
                "id": row.id,
                "word": row.word,
                "category": row.category or "general",
                "action": row.action or "block",
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
    }


@router.post("/sensitive-words")
async def create_sensitive_words(
    payload: SensitiveWordBatch,
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    items = _dedupe_words([
        item for item in (
            _normalize_word_item(w.model_dump()) for w in payload.words
        ) if item
    ])
    if not items:
        raise HTTPException(status_code=400, detail="没有有效的敏感词")

    inserted = await _insert_words(db, items)
    return {
        "imported": inserted,
        "skipped": len(items) - inserted,
        "total": len(items),
        "message": f"新增 {inserted} 个敏感词，跳过 {len(items) - inserted} 个已存在词条",
    }


@router.put("/sensitive-words/{word_id}")
async def update_sensitive_word(
    word_id: int,
    payload: SensitiveWordUpdate,
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(SensitiveWord).where(SensitiveWord.id == word_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="敏感词不存在")

    if payload.word is not None:
        word = payload.word.strip().lower()
        if not word:
            raise HTTPException(status_code=400, detail="敏感词不能为空")
        duplicated = (await db.execute(
            select(SensitiveWord.id).where(SensitiveWord.word == word, SensitiveWord.id != word_id)
        )).scalar_one_or_none()
        if duplicated:
            raise HTTPException(status_code=400, detail="该敏感词已存在")
        row.word = word
    if payload.category is not None:
        row.category = payload.category.strip()[:50] or "general"
    if payload.action is not None:
        row.action = payload.action

    await db.commit()
    await _reload_sensitive_now()
    return {"message": "已更新", "id": word_id}


@router.delete("/sensitive-words/{word_id}")
async def delete_sensitive_word(
    word_id: int,
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    row = (await db.execute(select(SensitiveWord).where(SensitiveWord.id == word_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="敏感词不存在")
    await db.delete(row)
    await db.commit()
    await _reload_sensitive_now()
    return {"message": "已删除", "id": word_id}


@router.post("/sensitive-words/bulk-delete")
async def bulk_delete_sensitive_words(
    payload: SensitiveWordBulkDelete,
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    if not payload.ids:
        return {"deleted": 0}
    result = await db.execute(
        delete(SensitiveWord).where(SensitiveWord.id.in_(payload.ids[:1000]))
    )
    await db.commit()
    await _reload_sensitive_now()
    return {"deleted": result.rowcount or 0}


class _BulkActionPayload(BaseModel):
    ids: list[int] = []
    action: str
    all: bool = False  # 对全量生效（7000+ 条时避免前端回传巨大 id 列表）


class _ClearAllPayload(BaseModel):
    confirm: str = ""


@router.post("/sensitive-words/bulk-action")
async def bulk_update_action(
    payload: _BulkActionPayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """批量设置处理方式。一次事务完成，避免前端逐条请求把库打满。"""
    if payload.action not in ("block", "replace", "warn"):
        raise HTTPException(status_code=400, detail="处理方式只能是 block / replace / warn")
    if payload.all:
        result = await db.execute(update(SensitiveWord).values(action=payload.action))
    else:
        ids = payload.ids[:1000]
        if not ids:
            return {"updated": 0}
        result = await db.execute(
            update(SensitiveWord).where(SensitiveWord.id.in_(ids)).values(action=payload.action)
        )
    await db.commit()
    await _reload_sensitive_now()
    return {"updated": result.rowcount or 0, "action": payload.action}


@router.post("/sensitive-words/clear-all")
async def clear_all_sensitive_words(
    payload: _ClearAllPayload,
    admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """清空词库：必须输入确认词，防止误触毁掉 7000+ 条配置。"""
    if (payload.confirm or "").strip() != "清空敏感词库":
        raise HTTPException(status_code=400, detail="请输入「清空敏感词库」以确认")
    result = await db.execute(delete(SensitiveWord))
    await db.commit()
    await _reload_sensitive_now()
    return {"deleted": result.rowcount or 0}


@router.post("/sensitive-words/import")
async def import_sensitive_words(
    file: UploadFile = File(...),
    _admin: User = Depends(get_current_root_admin),
    db: AsyncSession = Depends(get_db),
):
    """一键导入：JSON / TXT / CSV，自动识别格式并跳过重复与非法行。"""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件为空")
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件过大（上限 2MB）")

    try:
        text_data = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="文件需为 UTF-8 编码")

    items = _dedupe_words([item for item in _parse_sensitive_import(text_data) if item])
    if not items:
        raise HTTPException(status_code=400, detail="未解析到有效敏感词，请检查文件格式")

    inserted = await _insert_words(db, items)
    return {
        "imported": inserted,
        "skipped": len(items) - inserted,
        "total": len(items),
        "filename": file.filename,
        "message": f"导入完成：新增 {inserted} 个，跳过 {len(items) - inserted} 个重复或已存在词条",
    }
