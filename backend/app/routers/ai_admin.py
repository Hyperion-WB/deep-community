"""AI 管理（仅超级管理员）。配置持久化在 system_settings。"""
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.routers.deps import get_current_root_admin
from app.services.ai_service import (
    AI_KEYS, AI_VENDORS, EMOTION_PRESETS, ai_comment_stats, ai_daily_digest,
    chat_completion, fetch_models, finalize_comment, get_ai_user,
    load_ai_config, parse_character_card, save_ai_config,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ai", tags=["AI"])
admin_router = APIRouter(prefix="/admin/ai", tags=["AI-Admin"])


class AIConfigRequest(BaseModel):
    ai_vendor: Optional[str] = None
    ai_base_url: Optional[str] = None
    ai_model: Optional[str] = None
    ai_api_key: Optional[str] = None
    ai_user_name: Optional[str] = None
    ai_user_avatar: Optional[str] = None
    ai_style: Optional[str] = None
    ai_enabled: Optional[str] = None
    ai_auto_comment: Optional[str] = None
    ai_daily_limit: Optional[str] = None
    ai_reply_buffer_sec: Optional[str] = None
    # 人格 / 情感 / 回复设置
    ai_persona_name: Optional[str] = None
    ai_persona_desc: Optional[str] = None
    ai_persona_card: Optional[str] = None
    ai_catchphrase: Optional[str] = None
    ai_reply_mode: Optional[str] = None
    ai_reply_phrases: Optional[str] = None
    ai_emotion_intensity: Optional[str] = None
    ai_mood_enabled: Optional[str] = None
    ai_fun_enabled: Optional[str] = None
    ai_disable_thinking: Optional[str] = None


class ModelListRequest(BaseModel):
    base_url: str
    api_key: Optional[str] = None


def _mask(cfg: Dict[str, str]) -> Dict[str, Any]:
    key = cfg.get("ai_api_key") or ""
    masked = (key[:6] + "..." + key[-4:]) if len(key) > 12 else ("已配置" if key else "")
    out: Dict[str, Any] = {k: v for k, v in cfg.items() if k != "ai_api_key"}
    out["ai_api_key_masked"] = masked
    out["ai_api_key_set"] = bool(key)
    return out


@admin_router.get("/config")
async def get_ai_config(
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    cfg = await load_ai_config(db)
    return {
        "config": _mask(cfg),
        "vendors": AI_VENDORS,
        "emotions": [{"key": k, **v} for k, v in EMOTION_PRESETS.items()],
    }


@admin_router.put("/config")
async def update_ai_config(
    payload: AIConfigRequest,
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    values = payload.model_dump(exclude_none=True)
    # 前端留空表示「不修改 Key」，避免掩码回写覆盖真实值
    if not (values.get("ai_api_key") or "").strip():
        values.pop("ai_api_key", None)
    await save_ai_config(db, {k: v for k, v in values.items() if k in AI_KEYS})
    cfg = await load_ai_config(db)
    if (cfg.get("ai_user_name") or "").strip():
        await get_ai_user(db, cfg)
    return {"ok": True, "config": _mask(cfg)}


@admin_router.post("/models")
async def list_models(
    payload: ModelListRequest,
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    cfg = await load_ai_config(db)
    key = (payload.api_key or "").strip() or (cfg.get("ai_api_key") or "")
    if not key:
        raise HTTPException(status_code=400, detail="请先填写 API Key")
    try:
        models = await fetch_models(payload.base_url, key)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"拉取模型失败：{exc}")
    return {"models": models, "count": len(models)}


@admin_router.post("/test")
async def test_ai(
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    cfg = await load_ai_config(db)
    try:
        res = await chat_completion(cfg, [
            {"role": "system", "content": "你是一个技术社区用户，用一句不超过 40 字的话打个招呼。"},
            {"role": "user", "content": "请生成一条示范评论"},
        ])
        text = finalize_comment(res.get("text", ""), res.get("finish_reason", ""))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"调用失败：{exc}")
    return {"ok": True, "sample": text}


@admin_router.get("/stats")
async def ai_stats(
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    """AI 评论进度：为什么有的有评论、有的没有，一眼能看出来。"""
    return await ai_comment_stats(db)


@admin_router.post("/persona-card")
async def upload_persona_card(
    file: UploadFile = File(...),
    admin: User = Depends(get_current_root_admin),
):
    """上传开源角色卡 JSON（SillyTavern / TavernAI Character Card V1、V2 均可）。

    只解析数据格式，不执行卡片里的任何内容；解析结果由前端回填到人格设置。
    """
    import json as _json

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"文件不是 UTF-8 文本：{exc}")
    try:
        card = parse_character_card(text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"角色卡解析失败：{exc}")
    if not (card.get("name") or card.get("description") or card.get("personality")):
        raise HTTPException(status_code=400, detail="角色卡缺少 name / description / personality 字段")
    return {"ok": True, "card": card, "raw": text[:20000]}


@admin_router.get("/digest-preview")
async def digest_preview(
    admin: User = Depends(get_current_root_admin), db: AsyncSession = Depends(get_db),
):
    """预览今晚 20:00 会推送给超管的日报内容。"""
    return await ai_daily_digest(db)
