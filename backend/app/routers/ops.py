"""站点运维统计接口

- POST /ops/visit           前端埋点（公开，仅记录页面访问）
- GET  /admin/ops/overview  今日概览 + 内容存量 + 系统信息（仅超级管理员）
- GET  /admin/ops/trend     近 N 天走势（仅超级管理员）
- GET  /admin/ops/top-pages 近 N 天热门页面（仅超级管理员）
"""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import BaseModel, Field

from app.models.user import User
from app.routers.deps import get_current_root_admin
from app.services import ops_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ops", tags=["运维统计"])
admin_router = APIRouter(prefix="/admin/ops", tags=["运维面板"])


class VisitPayload(BaseModel):
    path: str = Field(default="/", max_length=255)


@router.post("/visit", status_code=204)
async def track_page_view(payload: VisitPayload, request: Request) -> Response:
    """前端路由切换埋点：只记录 SPA 页面路径，不记录 API/静态资源"""
    path = (payload.path or "/").split("?")[0][:255] or "/"
    if path.startswith(("/api", "/assets", "/uploads", "/favicon", "/icons", "/logo")):
        return Response(status_code=204)

    # nginx 写入的 X-Real-IP 可信；X-Forwarded-For 客户端可伪造，
    # 仅在缺少 X-Real-IP 时取最后一跳（离我们最近的代理），再退化为直连地址
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    forwarded = [part.strip() for part in (request.headers.get("x-forwarded-for") or "").split(",") if part.strip()]
    client_ip = real_ip or (forwarded[-1] if forwarded else (request.client.host if request.client else ""))
    user_agent = (request.headers.get("user-agent") or "")[:255]

    try:
        await ops_service.record_page_view(path, client_ip, user_agent)
    except Exception:
        # 埋点失败绝不影响用户主流程
        logger.warning("页面访问埋点写入失败 path=%s", path, exc_info=True)
    return Response(status_code=204)


@admin_router.get("/overview")
async def ops_overview(_: User = Depends(get_current_root_admin)) -> Dict[str, Any]:
    return await ops_service.get_overview()


@admin_router.get("/trend")
async def ops_trend(
    days: int = Query(default=14, ge=1, le=90),
    _: User = Depends(get_current_root_admin),
) -> List[Dict[str, Any]]:
    return await ops_service.get_trend(days)


@admin_router.get("/top-pages")
async def ops_top_pages(
    days: int = Query(default=7, ge=1, le=90),
    limit: int = Query(default=10, ge=1, le=50),
    _: User = Depends(get_current_root_admin),
) -> List[Dict[str, Any]]:
    return await ops_service.get_top_pages(days, limit)
