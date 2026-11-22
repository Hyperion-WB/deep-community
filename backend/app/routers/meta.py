"""站点公开元信息（无需登录）：前端据此决定是否走图片 CDN。"""
from fastapi import APIRouter
from app.core.config import settings

router = APIRouter(prefix="/meta", tags=["元信息"])


@router.get("/public")
async def public_meta():
    """图片一律走同源 /uploads/。

    浏览器直连 S3_PUBLIC_DOMAIN（R2 自定义域）会被 Cloudflare 防盗链 / WAF
    判定为跨站盗链而返回 403，且大图组件没有任何回退，表现为「点开大图报错」。
    主站 nginx 已能本地命中 /uploads/，缺失时由 @s3_mirror 做服务端回源，
    所以不需要浏览器跨域直连对象存储。
    将来若该域已允许跨站访问，可显式设置 S3_PUBLIC_BROWSER=1 重新启用。
    """
    allow_browser = bool(getattr(settings, "S3_PUBLIC_BROWSER", False))
    if not allow_browser:
        return {"cdn_domain": None, "cdn_enabled": False}
    mirror_on = bool(getattr(settings, "S3_MIRROR", False))
    domain = getattr(settings, "S3_PUBLIC_DOMAIN", None)
    cdn = domain if mirror_on and domain else None
    return {"cdn_domain": cdn, "cdn_enabled": bool(cdn)}
