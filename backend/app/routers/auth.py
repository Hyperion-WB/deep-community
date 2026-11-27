from datetime import date, datetime, timezone
from typing import Optional
from urllib.parse import quote
import asyncio
import hashlib
import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException, status, Request, Response, Query
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, func, update, text
from sqlalchemy.exc import IntegrityError
from app.core.database import get_db, get_redis, is_mock_redis
from app.core.config import settings
from app.core.security import (
    get_password_hash,
    get_password_hash_async,
    verify_password,
    verify_password_async,
    create_access_token,
    issue_refresh_token,
    decode_token,
)
from app.models.user import User, InviteCode, Follow, Checkin
from app.models.post import Post
from app.models.system import Notification
from app.schemas.user import (
    RegisterRequest,
    LoginRequest,
    RefreshTokenRequest,
    TokenSchema,
    UserProfileResponse,
    EmailCodeRequest,
    PasswordForgotRequest,
    PasswordResetRequest,
)
from app.services.anon_service import get_remaining_anon_quota
from app.services.ip_service import extract_client_ip, resolve_ip_location
from app.services.email_service import (
    is_email_configured,
    send_email,
    build_code_email,
    build_password_changed_email,
)
from app.services.email_code_service import issue_code, verify_code, cooldown_remaining
from app.services.session_service import (
    create_or_touch_session,
    get_session,
    revoke_session,
    sid_from_refresh,
    client_ip,
)
from app.services.captcha_service import (
    is_captcha_enabled,
    site_key,
    verify_captcha,
    login_requires_captcha,
    email_send_requires_captcha,
    count_email_send,
)
from app.routers.deps import get_current_user, get_current_user_optional

router = APIRouter(prefix="/auth", tags=["认证鉴权"])


def _site_origin(request: Request) -> str:
    """推导站点对外地址（nginx 反代场景取转发头）"""
    if settings.PUBLIC_SITE_URL:
        return settings.PUBLIC_SITE_URL.rstrip("/")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _qr_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


async def _qr_session(db: AsyncSession, scan_token: str, exchange_token: str):
    result = await db.execute(text(
        "SELECT id, status, user_id, expires_at FROM qr_login_sessions "
        "WHERE scan_hash=:scan AND exchange_hash=:exchange AND expires_at > now()"
    ), {"scan": _qr_hash(scan_token), "exchange": _qr_hash(exchange_token)})
    return result.mappings().first()


@router.post("/qr/create")
async def qr_create(request: Request, db: AsyncSession = Depends(get_db)):
    session_id, scan_token, exchange_token = secrets.token_urlsafe(16), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    await db.execute(text(
        "INSERT INTO qr_login_sessions(id, scan_hash, exchange_hash, expires_at) "
        "VALUES (:id, :scan, :exchange, now() + interval '2 minutes')"
    ), {"id": session_id, "scan": _qr_hash(scan_token), "exchange": _qr_hash(exchange_token)})
    await db.commit()
    return {"session_id": session_id, "scan_token": scan_token, "exchange_token": exchange_token,
            "url": f"{_site_origin(request)}/?qr_login={quote(scan_token)}", "expires_in": 120}


@router.post("/qr/scan")
async def qr_scan(
    payload: dict,
    request: Request,
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """手机扫码。

    - 已登录：立即把会话绑定到当前账号；
    - 未登录：允许先标记 scanned，但 scan-info/confirm 仍要求登录。
    QrLoginPage 会带着手机端 access_token 调用，因此正常流程会在这一步完成绑定。
    """
    token = str(payload.get("scan_token") or "")
    if len(token) < 32:
        raise HTTPException(status_code=400, detail="二维码无效")
    row = (await db.execute(text(
        "SELECT id, status, user_id, expires_at > now() AS alive "
        "FROM qr_login_sessions WHERE scan_hash=:scan"
    ), {"scan": _qr_hash(token)})).mappings().first()
    if not row or not row["alive"]:
        raise HTTPException(status_code=410, detail="二维码已失效")
    if row["status"] == "confirmed":
        raise HTTPException(status_code=409, detail="该登录请求已确认")
    if row["status"] == "consumed":
        raise HTTPException(status_code=410, detail="该登录请求已使用")
    bound = row.get("user_id")
    if bound and (not user or str(bound) != str(user.id)):
        raise HTTPException(status_code=409, detail="该二维码已被其他账号扫描")
    if row["status"] == "scanned":
        return {"session_id": row["id"]}
    await db.execute(text(
        "UPDATE qr_login_sessions SET status='scanned', user_id=COALESCE(:uid, user_id) "
        "WHERE id=:id AND status='pending'"
    ), {"uid": user.id if user else None, "id": row["id"]})
    await db.commit()
    return {"session_id": row["id"]}


@router.get("/qr/scan-info")
async def qr_scan_info(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.status in ("banned", "deactivated", "deleting") or user.must_change_password:
        raise HTTPException(status_code=403, detail="当前账号暂不能使用扫码登录")
    row = (await db.execute(text(
        "SELECT id, status, user_id, expires_at > now() AS alive "
        "FROM qr_login_sessions WHERE id=:id"
    ), {"id": session_id})).mappings().first()
    if not row or not row["alive"]:
        raise HTTPException(status_code=410, detail="二维码已失效，请重新扫描")
    if row["status"] not in ("scanned", "confirmed"):
        raise HTTPException(status_code=409, detail="请先扫描二维码")
    if row["user_id"] and str(row["user_id"]) != str(user.id):
        raise HTTPException(status_code=403, detail="该登录请求不属于当前账号")
    return {
        "session_id": session_id,
        "username": user.username,
        "nickname": user.nickname or user.username,
    }


@router.post("/qr/confirm")
async def qr_confirm(payload: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session_id = str(payload.get("session_id") or "")
    fresh = await db.get(User, user.id)
    if not fresh or fresh.status in ("banned", "deactivated", "deleting") or fresh.must_change_password:
        raise HTTPException(status_code=403, detail="当前账号暂不能确认登录")
    row = (await db.execute(text(
        "SELECT id, status, user_id, expires_at > now() AS alive "
        "FROM qr_login_sessions WHERE id=:id"
    ), {"id": session_id})).mappings().first()
    if not row or not row["alive"]:
        raise HTTPException(status_code=410, detail="登录请求已失效，请刷新二维码")
    if row["user_id"] and str(row["user_id"]) != str(user.id):
        raise HTTPException(status_code=403, detail="该登录请求不属于当前账号")
    if row["status"] == "confirmed":
        return {"status": "confirmed"}
    if row["status"] != "scanned":
        raise HTTPException(status_code=409, detail="请先扫描二维码")
    result = await db.execute(text(
        "UPDATE qr_login_sessions SET status='confirmed', user_id=:uid WHERE id=:id "
        "AND status='scanned' AND expires_at > now() RETURNING id"
    ), {"uid": user.id, "id": session_id})
    if not result.first():
        await db.rollback()
        raise HTTPException(status_code=409, detail="登录请求已失效，请刷新二维码")
    await db.commit()
    return {"status": "confirmed"}


@router.post("/qr/status")
async def qr_status(payload: dict, db: AsyncSession = Depends(get_db)):
    row = await _qr_session(db, str(payload.get("scan_token") or ""), str(payload.get("exchange_token") or ""))
    if not row:
        raise HTTPException(status_code=410, detail="二维码已过期")
    return {"status": row["status"]}


@router.post("/qr/exchange", response_model=TokenSchema)
async def qr_exchange(payload: dict, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    scan_token = str(payload.get("scan_token") or "")
    exchange_token = str(payload.get("exchange_token") or "")
    row = await _qr_session(db, scan_token, exchange_token)
    if not row or row["status"] != "confirmed":
        raise HTTPException(status_code=409, detail="尚未确认登录或二维码已过期")
    result = await db.execute(text(
        "UPDATE qr_login_sessions SET status='consumed' WHERE id=:id AND status='confirmed' "
        "AND expires_at > now() RETURNING user_id"
    ), {"id": row["id"]})
    consumed = result.first()
    if not consumed:
        await db.rollback()
        raise HTTPException(status_code=409, detail="登录请求已使用")
    user = await db.scalar(select(User).where(User.id == consumed[0]).with_for_update())
    if not user or user.status in ("banned", "deactivated", "deleting") or user.must_change_password:
        await db.rollback()
        raise HTTPException(status_code=403, detail="此账号当前无法登录")
    tokens = await _issue_tokens(db, user, request, response=response)
    return tokens


@router.post("/qr/cancel")
async def qr_cancel(payload: dict, db: AsyncSession = Depends(get_db)):
    row = await _qr_session(db, str(payload.get("scan_token") or ""), str(payload.get("exchange_token") or ""))
    if row:
        await db.execute(text("UPDATE qr_login_sessions SET status='cancelled' WHERE id=:id AND status <> 'consumed'"), {"id": row["id"]})
        await db.commit()
    return {"status": "cancelled"}




@router.get("/github/enabled")
async def github_oauth_enabled():
    """前端探测 GitHub 登录是否已配置（未配置时隐藏登录入口）"""
    return {"enabled": bool(settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET)}


@router.get("/github/login")
async def github_login(request: Request):
    """生成 GitHub OAuth 授权跳转（未配置密钥时返回 503）"""
    if not settings.GITHUB_CLIENT_ID or not settings.GITHUB_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="GitHub 登录尚未配置（需在 .env 中设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）")

    state = uuid.uuid4().hex
    redis = get_redis()
    if redis:
        try:
            await redis.set(f"oauth:state:{state}", "1", ex=600)
        except Exception:
            pass

    redirect_uri = f"{_site_origin(request)}/api/auth/github/callback"
    url = (
        "https://github.com/login/oauth/authorize"
        f"?client_id={settings.GITHUB_CLIENT_ID}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&state={state}"
        "&scope=read:user user:email"
    )
    return RedirectResponse(url)


@router.get("/github/callback")
async def github_callback(code: str = "", state: str = "", request: Request = None, db: AsyncSession = Depends(get_db)):
    """GitHub 回调：换取用户身份，绑定/创建账号并签发令牌，重定向回前端"""
    frontend = _site_origin(request) if request else ""

    def _fail(msg: str) -> RedirectResponse:
        return RedirectResponse(f"{frontend}/#github_error={quote(msg, safe='')}", status_code=302)

    if not settings.GITHUB_CLIENT_ID or not settings.GITHUB_CLIENT_SECRET:
        return _fail("GitHub 登录未配置")
    if not code:
        return _fail("授权失败：缺少授权码")

    # state 防 CSRF 校验：必须存在且一次性消费成功，任何异常都拒绝（fail-closed）
    if not state:
        return _fail("授权状态缺失，请重新发起登录")
    redis = get_redis()
    if not redis:
        return _fail("登录服务暂时不可用，请稍后重试")
    try:
        if not await redis.delete(f"oauth:state:{state}"):
            return _fail("授权状态校验失败，请重试")
    except Exception:
        return _fail("授权状态校验失败，请重试")

    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_res = await client.post(
                "https://github.com/login/oauth/access_token",
                json={
                    "client_id": settings.GITHUB_CLIENT_ID,
                    "client_secret": settings.GITHUB_CLIENT_SECRET,
                    "code": code,
                    "redirect_uri": f"{_site_origin(request)}/api/auth/github/callback" if request else "",
                },
                headers={"Accept": "application/json"},
            )
            access = (token_res.json() or {}).get("access_token")
            if not access:
                return _fail("GitHub 授权码兑换失败")

            user_res = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json"},
            )
            gh_user = user_res.json() or {}
            gh_id = str(gh_user.get("id") or "")
            if not gh_id:
                return _fail("获取 GitHub 用户信息失败")

            emails_res = await client.get(
                "https://api.github.com/user/emails",
                headers={"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json"},
            )
            gh_email = next(
                (e.get("email") for e in (emails_res.json() or []) if e.get("primary") and e.get("verified")),
                None,
            )
    except Exception:
        return _fail("GitHub 服务连接失败，请稍后重试")

    # 1. 已绑定：直接登录
    user = (await db.execute(select(User).where(User.github_id == gh_id))).scalar_one_or_none()
    if not user:
        # 2. 未绑定：按邮箱匹配老用户则自动绑定（仅接受 GitHub 已验证邮箱），否则新建账号
        candidate = None
        if gh_email:
            candidate = (await db.execute(select(User).where(User.email == gh_email.lower()))).scalar_one_or_none()
        if candidate and candidate.github_id is None and candidate.status != "banned":
            user = candidate
            user.github_id = gh_id
            # GitHub 已验证的主邮箱可作为邮箱所有权证明
            if not user.email_verified:
                user.email_verified = True
                user.email_verified_at = datetime.now(timezone.utc)
        else:
            # 新建 GitHub 账号：见习会员起步（与公开注册一致）
            base_name = (gh_user.get("login") or f"gh{gh_id[-6:]}")[:24].strip() or f"gh{gh_id[-6:]}"
            clean_name = "".join(c for c in base_name if c.isalnum() or c in "_-") or f"gh{gh_id[-6:]}"
            username = clean_name
            for i in range(1, 50):
                if not (await db.execute(select(User.id).where(User.username == username))).scalar_one_or_none():
                    break
                username = f"{clean_name[:28]}{i}"
            email = (gh_email or f"{gh_id}@users.noreply.github.com").lower()
            email_taken = (await db.execute(select(User.id).where(User.email == email))).scalar_one_or_none()
            if email_taken:
                email = f"{gh_id}@users.noreply.github.com"
            user = User(
                username=username,
                email=email,
                # OAuth 账号无密码：以不可登录的随机哈希占位
                password_hash=await get_password_hash_async(uuid.uuid4().hex + uuid.uuid4().hex),
                status="probation",
                level=0,
                experience=0,
                active_days=1,
                last_active_date=date.today(),
                register_channel="github",
                github_id=gh_id,
                avatar_url=gh_user.get("avatar_url") or None,
                github_url=gh_user.get("html_url") or "",
                email_verified=bool(gh_email),
                email_verified_at=datetime.now(timezone.utc) if gh_email else None,
            )
            db.add(user)
            # 并发首次登录：两者都判定「用户名可用」时后者会撞唯一约束，
            # 先 flush 捕获冲突再回读已建账号，避免回调 500
            try:
                await db.flush()
            except IntegrityError:
                await db.rollback()
                existing = (await db.execute(
                    select(User).where(User.github_id == gh_id)
                )).scalar_one_or_none()
                if not existing:
                    return _fail("账号创建冲突，请稍后重试")
                user = existing

    if user.status == "banned":
        return _fail("该账号已被封禁，无法登录")
    if user.status == "deactivated":
        return _fail("该账号已注销")
    if user.status == "deleting":
        return _fail("该账号已申请注销，正处于 10 天缓冲期；如需恢复请联系超级管理员")

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    tokens = await _issue_tokens(db, user, request)
    # 只把短期 access token 放进 URL fragment（# 不会进入服务器访问日志）；
    # 长期 refresh 必须走 HttpOnly Cookie，否则 fragment 可被页面 JS 与浏览器历史读取。
    redirect = RedirectResponse(
        f"{frontend}/#github_auth=1&access_token={tokens.access_token}",
        status_code=302,
    )
    if tokens.refresh_token:
        set_refresh_cookie(redirect, tokens.refresh_token, request)
    return redirect

# ===== 刷新令牌 Cookie =====
# refresh token 只放 HttpOnly Cookie，JS 无法读取，即使出现 XSS 也无法窃取长期凭证。
# path 限定到 /api/auth，避免随每个业务请求发送。
REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/api/auth"

# 原子 compare-and-set：只有「服务端当前令牌 == 本次提交的令牌」时才替换为新令牌。
# 并发刷新时只有一个请求能成功轮换，其余请求读取赢家的令牌原样返回，
# 从而保证所有响应写入同一个 Cookie，不会产生"孤儿令牌"导致下次被动登出。
_REFRESH_SWAP_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
"""


def _cookie_secure(request: Optional[Request]) -> bool:
    """仅在 HTTPS 下加 Secure 标记；本地 http 调试时不加，否则 Cookie 不会被写入。"""
    if request is None:
        return True
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"


def set_refresh_cookie(response: Response, token: str, request: Optional[Request]) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="lax",
        path=REFRESH_COOKIE_PATH,
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=REFRESH_COOKIE_NAME, path=REFRESH_COOKIE_PATH)


def _read_refresh_token(request: Request, req: Optional[RefreshTokenRequest]) -> Optional[str]:
    """优先从 HttpOnly Cookie 读取；body 分支仅为兼容尚未更新的旧客户端。"""
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if token:
        return token
    return req.refresh_token if req else None


async def _issue_tokens(
    db: AsyncSession,
    user: User,
    request: Optional[Request],
    sid: Optional[str] = None,
    response: Optional[Response] = None,
) -> TokenSchema:
    """签发 access/refresh 并登记登录会话（刷新沿用同一 sid，设备列表不会膨胀）。

    传入 response 时把 refresh token 写入 HttpOnly Cookie，响应体只返回 access token。
    """
    session_id = sid or uuid.uuid4().hex
    refresh_token = await issue_refresh_token(
        user.id, token_version=user.token_version or 0, session_id=session_id
    )
    await create_or_touch_session(db, session_id, user.id, request, refresh_token)
    await db.commit()
    access_token = create_access_token(
        user.id, user.role, user.token_version or 0, sid=session_id
    )
    if response is not None:
        set_refresh_cookie(response, refresh_token, request)
        return TokenSchema(access_token=access_token, refresh_token=None)
    return TokenSchema(access_token=access_token, refresh_token=refresh_token)


async def _guard_captcha(token: Optional[str], request: Optional[Request], required: bool) -> None:
    """未启用或未达阈值时直接放行；否则校验 Turnstile token。"""
    if not required:
        return
    if not token:
        raise HTTPException(
            status_code=400,
            detail="请先完成人机验证",
            headers={"X-Captcha-Required": "1"},
        )
    if not await verify_captcha(token, client_ip(request)):
        raise HTTPException(
            status_code=400,
            detail="人机验证未通过，请刷新后重试",
            headers={"X-Captcha-Required": "1"},
        )


@router.get("/captcha")
async def captcha_config():
    """前端据此决定是否渲染 Turnstile，以及登录第几次失败后出现。"""
    return {
        "enabled": is_captcha_enabled(),
        "site_key": site_key(),
        "login_after_failures": settings.CAPTCHA_LOGIN_AFTER_FAILURES,
    }


def _email_verification_required() -> bool:
    """只有 SMTP 可用时才强制邮箱验证，避免未配置邮件服务时把注册彻底锁死。"""
    return bool(settings.EMAIL_VERIFICATION_REQUIRED and is_email_configured())


@router.get("/email/enabled")
async def email_service_status():
    """前端据此决定是否展示验证码输入框与「忘记密码」入口。"""
    configured = is_email_configured()
    return {
        "configured": configured,
        "required": _email_verification_required(),
        "dev_expose_code": bool(settings.EMAIL_DEV_EXPOSE_CODE and not configured),
    }


@router.post("/email/code")
async def send_email_code(
    req: EmailCodeRequest,
    request: Request,
    user: Optional[User] = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    """发送邮箱验证码（注册 / 重置密码 / 绑定新邮箱）。"""
    email = str(req.email).strip().lower()
    purpose = req.purpose

    if purpose == "bind_email" and not user:
        raise HTTPException(status_code=401, detail="请先登录后再绑定邮箱")

    # 频繁发信需要人机校验（同一 IP 每小时计数，达到阈值后强制）
    sender_ip = client_ip(request)
    await _guard_captcha(req.captcha_token, request, await email_send_requires_captcha(sender_ip))

    wait = await cooldown_remaining(purpose, email)
    if wait > 0:
        raise HTTPException(status_code=429, detail=f"验证码已发送，请 {wait} 秒后再试")

    target = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()

    if purpose == "register" and target:
        raise HTTPException(status_code=400, detail="该邮箱已被注册，请直接登录或使用找回密码")
    if purpose == "bind_email" and target and target.id != user.id:
        raise HTTPException(status_code=400, detail="该邮箱已被其他账号使用")
    if purpose == "reset" and (not target or target.status in ("banned", "deactivated", "deleting")):
        # 防邮箱枚举：未注册/不可用账号也返回同样的提示，但不真正发信
        return {
            "message": "如果该邮箱已注册，验证码已发送",
            "cooldown_seconds": settings.EMAIL_CODE_RESEND_SECONDS,
            "expires_in": settings.EMAIL_CODE_TTL_SECONDS,
        }

    code = await issue_code(purpose, email)
    await count_email_send(sender_ip)
    subject, html, text = build_code_email(code, purpose, _site_origin(request))
    sent = await send_email(email, subject, html, text)

    if not sent and is_email_configured():
        raise HTTPException(status_code=502, detail="邮件发送失败，请稍后重试或联系管理员")

    payload = {
        "message": "验证码已发送，请查收邮件（含垃圾邮件箱）"
        if sent
        else "站点尚未配置邮件服务，验证码已写入服务端日志",
        "cooldown_seconds": settings.EMAIL_CODE_RESEND_SECONDS,
        "expires_in": settings.EMAIL_CODE_TTL_SECONDS,
    }
    # 仅内网自测：未接入 SMTP 且显式开启时回传验证码，生产务必保持关闭
    if not sent and settings.EMAIL_DEV_EXPOSE_CODE:
        payload["dev_code"] = code
    return payload


@router.post("/password/forgot")
async def forgot_password(
    req: PasswordForgotRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """忘记密码：向注册邮箱发送重置验证码（对外结果恒定，避免枚举邮箱）。"""
    email = str(req.email).strip().lower()

    sender_ip = client_ip(request)
    await _guard_captcha(req.captcha_token, request, await email_send_requires_captcha(sender_ip))

    wait = await cooldown_remaining("reset", email)
    if wait > 0:
        raise HTTPException(status_code=429, detail=f"验证码已发送，请 {wait} 秒后再试")

    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user and user.status not in ("banned", "deactivated", "deleting"):
        code = await issue_code("reset", email)
        await count_email_send(sender_ip)
        subject, html, text = build_code_email(code, "reset", _site_origin(request))
        await send_email(email, subject, html, text)
    elif settings.EMAIL_DEV_EXPOSE_CODE and not is_email_configured():
        # 自测模式下也生成验证码，便于直接走通重置流程
        await issue_code("reset", email)

    return {
        "message": "如果该邮箱已注册，重置验证码已发送，请注意查收（含垃圾邮件箱）",
        "cooldown_seconds": settings.EMAIL_CODE_RESEND_SECONDS,
        "expires_in": settings.EMAIL_CODE_TTL_SECONDS,
    }


@router.post("/password/reset")
async def reset_password(
    req: PasswordResetRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """使用邮箱验证码重置密码：成功后吊销全部旧令牌并发送安全提醒邮件。"""
    email = str(req.email).strip().lower()
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user or user.status in ("banned", "deactivated", "deleting"):
        raise HTTPException(status_code=400, detail="验证码无效或已过期，请重新获取")

    ok, msg = await verify_code("reset", email, req.code)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)

    user.password_hash = await get_password_hash_async(req.new_password)
    # 自增令牌版本：此前签发的所有 access/refresh 立即失效，防止旧会话被劫持后继续使用
    user.token_version = (user.token_version or 0) + 1
    user.must_change_password = False
    user.email_verified = True
    user.email_verified_at = datetime.now(timezone.utc)
    db.add(Notification(
        receiver_id=user.id,
        action_type="system",
        target_id=user.id,
        brief="你的登录密码已通过邮箱验证码重置，所有旧登录凭证已失效。如非本人操作请立即联系管理员。",
    ))

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(status_code=500, detail="密码重置失败，请稍后重试")

    subject, html, text = build_password_changed_email(_site_origin(request))
    await send_email(email, subject, html, text)
    return {"message": "密码已重置，请使用新密码登录"}


@router.get("/gitee/enabled")
async def gitee_oauth_enabled():
    """前端探测 Gitee 登录是否已配置（未配置时隐藏入口）。"""
    return {"enabled": bool(settings.GITEE_CLIENT_ID and settings.GITEE_CLIENT_SECRET)}


@router.post("/gitee/bind/prepare")
async def prepare_gitee_bind(user: User = Depends(get_current_user)):
    """站内已登录用户手动绑定 Gitee：先签发一次性 state，避免把 access token 放进跳转 URL。"""
    if not settings.GITEE_CLIENT_ID or not settings.GITEE_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail="Gitee 登录尚未配置")
    redis = get_redis()
    if not redis:
        raise HTTPException(status_code=503, detail="绑定服务暂时不可用")
    state = uuid.uuid4().hex
    await redis.set(f"oauth:state:{state}", f"bind:{user.id}", ex=600)
    return {"state": state}


@router.get("/gitee/bind")
async def gitee_bind(state: str = Query(...), request: Request = None):
    """校验 prepare 签发的 state 后跳转 Gitee 授权页。"""
    redis = get_redis()
    if not redis:
        raise HTTPException(status_code=503, detail="绑定服务暂时不可用")
    raw = await redis.get(f"oauth:state:{state}")
    value = raw.decode() if isinstance(raw, bytes) else (raw or "")
    if not value.startswith("bind:"):
        raise HTTPException(status_code=400, detail="绑定状态无效或已过期，请重新发起")
    redirect_uri = f"{_site_origin(request)}/api/auth/gitee/callback"
    url = (
        "https://gitee.com/oauth/authorize"
        f"?client_id={settings.GITEE_CLIENT_ID}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        "&response_type=code"
        f"&state={state}"
    )
    return RedirectResponse(url)


@router.get("/gitee/login")
async def gitee_login(request: Request):
    if not settings.GITEE_CLIENT_ID or not settings.GITEE_CLIENT_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Gitee 登录尚未配置（需在 .env 中设置 GITEE_CLIENT_ID / GITEE_CLIENT_SECRET）",
        )

    state = uuid.uuid4().hex
    redis = get_redis()
    if redis:
        try:
            await redis.set(f"oauth:state:{state}", "1", ex=600)
        except Exception:
            pass

    redirect_uri = f"{_site_origin(request)}/api/auth/gitee/callback"
    url = (
        "https://gitee.com/oauth/authorize"
        f"?client_id={settings.GITEE_CLIENT_ID}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        "&response_type=code"
        f"&state={state}"
    )
    return RedirectResponse(url)


@router.get("/gitee/callback")
async def gitee_callback(
    code: str = "",
    state: str = "",
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """Gitee 回调：换取身份、绑定或创建账号，令牌经 URL fragment 回传前端。"""
    frontend = _site_origin(request) if request else ""

    def _fail(msg: str) -> RedirectResponse:
        return RedirectResponse(f"{frontend}/#gitee_error={quote(msg, safe='')}", status_code=302)

    if not settings.GITEE_CLIENT_ID or not settings.GITEE_CLIENT_SECRET:
        return _fail("Gitee 登录未配置")
    if not code:
        return _fail("授权失败：缺少授权码")
    if not state:
        return _fail("授权状态缺失，请重新发起登录")

    redis = get_redis()
    if not redis:
        return _fail("登录服务暂时不可用，请稍后重试")
    bind_user_id = None
    try:
        raw_state = await redis.get(f"oauth:state:{state}")
        value = raw_state.decode() if isinstance(raw_state, bytes) else (raw_state or "")
        if not value:
            return _fail("授权状态校验失败，请重试")
        await redis.delete(f"oauth:state:{state}")
        # prepare 签发的绑定态：值为 bind:<user_id>
        if value.startswith("bind:"):
            bind_user_id = value[5:]
    except Exception:
        return _fail("授权状态校验失败，请重试")

    import httpx

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            token_res = await client.post(
                "https://gitee.com/oauth/token",
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "client_id": settings.GITEE_CLIENT_ID,
                    "client_secret": settings.GITEE_CLIENT_SECRET,
                    "redirect_uri": f"{_site_origin(request)}/api/auth/gitee/callback" if request else "",
                },
                headers={"Accept": "application/json"},
            )
            access = (token_res.json() or {}).get("access_token")
            if not access:
                return _fail("Gitee 授权码兑换失败")

            user_res = await client.get(
                "https://gitee.com/api/v5/user",
                params={"access_token": access},
            )
            g_user = user_res.json() or {}
            gid = str(g_user.get("id") or "")
            if not gid:
                return _fail("获取 Gitee 用户信息失败")
            g_email = (g_user.get("email") or "").strip().lower() or None
    except Exception:
        return _fail("Gitee 服务连接失败，请稍后重试")

    if bind_user_id:
        # 绑定模式：身份已由站内登录态确认，不再按邮箱自动合并、不新建账号
        try:
            bind_uid = uuid.UUID(bind_user_id)
        except (ValueError, TypeError):
            return _fail("绑定状态无效，请重新发起")
        bind_user = (await db.execute(select(User).where(User.id == bind_uid))).scalar_one_or_none()
        if not bind_user:
            return _fail("账号不存在，请重新登录后再绑定")
        conflict = (await db.execute(
            select(User).where(User.gitee_id == gid, User.id != bind_uid)
        )).scalar_one_or_none()
        if conflict:
            return _fail("该 Gitee 账号已绑定其他用户")
        bind_user.gitee_id = gid
        await db.commit()
        return RedirectResponse(f"{frontend}/#gitee_bound=1", status_code=302)

    user = (await db.execute(select(User).where(User.gitee_id == gid))).scalar_one_or_none()
    if not user:
        # 安全：Gitee 的 email 是用户自填、无 verified 标记，
        # 不能像 GitHub（只取 primary && verified）那样按邮箱自动合并到已有账号，
        # 否则攻击者填受害者邮箱即可直接接管账号。
        # 绑定 Gitee 必须走「站内已登录后手动绑定」路径，此处一律新建账号。
        base_name = (g_user.get("login") or g_user.get("name") or f"gitee{gid[-6:]}")[:24].strip() or f"gitee{gid[-6:]}"
        clean_name = "".join(c for c in base_name if c.isalnum() or c in "_-") or f"gitee{gid[-6:]}"
        username = clean_name
        for i in range(1, 50):
            if not (await db.execute(select(User.id).where(User.username == username))).scalar_one_or_none():
                break
            username = f"{clean_name[:28]}{i}"
        email = (g_email or f"gitee{gid}@users.noreply.gitee.com").lower()
        email_taken = (await db.execute(select(User.id).where(User.email == email))).scalar_one_or_none()
        if email_taken:
            email = f"gitee{gid}@users.noreply.gitee.com"
        user = User(
            username=username,
            email=email,
            # OAuth 账号无密码：以不可登录的随机哈希占位
            password_hash=await get_password_hash_async(uuid.uuid4().hex + uuid.uuid4().hex),
            status="probation",
            level=0,
            experience=0,
            active_days=1,
            last_active_date=date.today(),
            register_channel="gitee",
            gitee_id=gid,
            avatar_url=g_user.get("avatar_url") or None,
            blog_url=(g_user.get("blog") or "")[:255],
            # Gitee 邮箱不可信：一律按未验证处理
            email_verified=False,
            email_verified_at=None,
        )
        db.add(user)
        try:
            await db.flush()
        except IntegrityError:
            await db.rollback()
            existing = (await db.execute(
                select(User).where(User.gitee_id == gid)
            )).scalar_one_or_none()
            if not existing:
                return _fail("账号创建冲突，请稍后重试")
            user = existing

    if user.status == "banned":
        return _fail("该账号已被封禁，无法登录")
    if user.status == "deactivated":
        return _fail("该账号已注销")
    if user.status == "deleting":
        return _fail("该账号已申请注销，正处于 10 天缓冲期；如需恢复请联系超级管理员")

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    tokens = await _issue_tokens(db, user, request)
    redirect = RedirectResponse(
        f"{frontend}/#gitee_auth=1&access_token={tokens.access_token}",
        status_code=302,
    )
    set_refresh_cookie(redirect, tokens.refresh_token, request)
    return redirect


@router.post("/register", response_model=TokenSchema)
async def register(
    req: RegisterRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    # 注册启用人机校验（Cloudflare Turnstile 未配置时自动放行）
    await _guard_captcha(req.captcha_token, request, is_captcha_enabled())

    # 检查用户名和邮箱冲突（注销缓冲期内的账号仍然占用，防止绕过 10 天冷静期重新注册）
    name_taken = (await db.execute(select(User.id).where(User.username == req.username))).scalar_one_or_none()
    if name_taken:
        holder = (await db.execute(select(User.status).where(User.username == req.username))).scalar_one_or_none()
        hint = "（该账号已申请注销，10 天缓冲期内用户名不会被释放）" if holder == "deleting" else ""
        raise HTTPException(status_code=400, detail=f"该用户名已被占用{hint}")
    email_taken = (await db.execute(select(User.id).where(User.email == req.email))).scalar_one_or_none()
    if email_taken:
        raise HTTPException(status_code=400, detail="该邮箱已被注册，请直接登录或使用找回密码")

    # 邮箱验证：SMTP 就绪时强制要求验证码（与前端 /auth/email/enabled 返回的 required 一致）
    email_verified = False
    normalized_email = str(req.email).strip().lower()
    if _email_verification_required():
        if not req.email_code:
            raise HTTPException(status_code=400, detail="请输入邮箱验证码完成验证")
        ok, msg = await verify_code("register", normalized_email, req.email_code)
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        email_verified = True
    elif req.email_code:
        # 未强制验证时，用户主动填了验证码同样必须校验通过，不能静默忽略错误
        ok, msg = await verify_code("register", normalized_email, req.email_code)
        if not ok:
            raise HTTPException(status_code=400, detail=msg)
        email_verified = True

    # 默认注册为见习会员 (probation, Lv.0, 0 EXP, 活跃天数 1 天)，需活跃满 5 天或管理员审核自动转正
    initial_status = "probation"
    initial_level = 0
    initial_exp = 0
    channel = "public"

    if req.invite_code:
        code_query = select(InviteCode).where(
            InviteCode.code == req.invite_code,
            InviteCode.is_used == False,
            InviteCode.expires_at > datetime.now(timezone.utc)
        )
        code_res = await db.execute(code_query)
        inv_code = code_res.scalar_one_or_none()
        if not inv_code:
            raise HTTPException(status_code=400, detail="邀请码无效或已过期")
        
        # 拥有有效邀请码的用户直达 Lv.1 正式会员 (active, Lv.1, 10 EXP)
        initial_status = "active"
        initial_level = 1
        initial_exp = 10
        channel = "invite"

    # 解析注册客户端真实 IP 与属地
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "")
    ip_loc = await asyncio.to_thread(resolve_ip_location, client_ip)

    new_user = User(
        username=req.username,
        email=str(req.email).strip().lower(),
        password_hash=await get_password_hash_async(req.password),
        status=initial_status,
        level=initial_level,
        experience=initial_exp,
        active_days=1,
        last_active_date=date.today(),
        register_channel=channel,
        ip_location=ip_loc,
        email_verified=email_verified,
        email_verified_at=datetime.now(timezone.utc) if email_verified else None,
    )
    db.add(new_user)
    await db.flush()

    # 邀请码原子核销：条件 UPDATE + rowcount 判定，杜绝并发一码多用
    # (旧实现为"查询→内存标记"，两个并发注册可同时通过校验)
    if req.invite_code:
        consume = await db.execute(
            update(InviteCode)
            .where(
                InviteCode.code == req.invite_code,
                InviteCode.is_used == False,
                InviteCode.expires_at > datetime.now(timezone.utc),
            )
            .values(is_used=True, used_by_id=new_user.id)
        )
        if consume.rowcount == 0:
            await db.rollback()
            raise HTTPException(status_code=400, detail="邀请码无效或已过期")

    await db.commit()

    # 用户已经落库，这里再出错**绝不能**让前端以为注册失败 ——
    # 否则用户会看到"注册失败"，重试又提示"用户名已存在"，
    # 实际上账号已经可用了（历史上就出现过这种困惑）。
    try:
        return await _issue_tokens(db, new_user, request, response=response)
    except Exception as exc:
        print(
            f"[Auth][register] 令牌签发失败 user={new_user.username}: "
            f"{type(exc).__name__} {str(exc)[:160]}"
        )
        try:
            await db.rollback()
        except Exception:
            pass
        # 退化为「只给 access token」：不登记设备会话，但用户能立刻进入站点
        try:
            access_token = create_access_token(
                new_user.id, new_user.role, new_user.token_version or 0
            )
        except Exception:
            raise HTTPException(
                status_code=503,
                detail="账号已创建成功，请直接使用刚才的账号密码登录",
            )
        if response is not None:
            try:
                fallback_refresh = await issue_refresh_token(
                    new_user.id, token_version=new_user.token_version or 0
                )
                set_refresh_cookie(response, fallback_refresh, request)
            except Exception:
                pass
            return TokenSchema(access_token=access_token, refresh_token=None)
        return TokenSchema(access_token=access_token, refresh_token=None)

@router.post("/login", response_model=TokenSchema)
async def login(req: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    query = select(User).where(or_(User.username == req.username_or_email, User.email == req.username_or_email))
    res = await db.execute(query)
    user = res.scalar_one_or_none()

    # 防爆破锁定：同一账号 5 次失败后锁定 5 分钟（Redis 计数，多 worker 一致）
    # 身份键优先用用户 ID：否则「用用户名」和「用邮箱」登录会各算一套失败次数，
    # 交替使用就能把 5 次的阈值翻倍。
    identity_key = (req.username_or_email or "").strip().lower()[:64]
    if user:
        identity_key = f"uid:{user.id}"
    redis = get_redis()
    lock_key = f"login:lock:{identity_key}"
    fail_key = f"login:fail:{identity_key}"

    # 同一账号密码错误达到阈值后强制人机校验，防止撞库
    await _guard_captcha(req.captcha_token, request, await login_requires_captcha(identity_key))

    if redis:
        try:
            if await redis.exists(lock_key):
                ttl = await redis.ttl(lock_key)
                wait_min = max(1, (ttl or 300) // 60 + (1 if (ttl or 300) % 60 else 0))
                raise HTTPException(
                    status_code=429,
                    detail=f"登录失败次数过多，账号已临时锁定，请约 {wait_min} 分钟后再试"
                )
        except HTTPException:
            raise
        except Exception:
            pass

    # 统一返回 401，避免通过状态码区分"账号不存在"与"密码错误"
    if not user or not await verify_password_async(req.password, user.password_hash):
        need_captcha_next = False
        if redis:
            try:
                cnt = await redis.incr(fail_key)
                await redis.expire(fail_key, 300)
                need_captcha_next = cnt >= settings.CAPTCHA_LOGIN_AFTER_FAILURES
                if cnt >= 5:
                    await redis.set(lock_key, "1", ex=300)
                    await redis.delete(fail_key)
            except Exception:
                pass
        # 带上响应头，前端据此立即渲染人机校验组件
        raise HTTPException(
            status_code=401,
            detail="用户名或密码错误",
            headers={"X-Captcha-Required": "1"} if need_captcha_next else None,
        )

    if user.status == "banned":
        raise HTTPException(status_code=403, detail="该账号已被封禁")
    if user.status == "deactivated":
        raise HTTPException(status_code=403, detail="该账号已注销")
    if user.status == "deleting":
        raise HTTPException(status_code=403, detail="该账号已申请注销，正处于 10 天缓冲期；如需恢复请联系超级管理员")

    if redis:
        try:
            await redis.delete(fail_key)
        except Exception:
            pass

    user.last_login_at = datetime.now(timezone.utc)

    # 自动识别更新客户端 IP 归属地
    client_ip = extract_client_ip(dict(request.headers), request.client.host if request.client else "")
    ip_loc = await asyncio.to_thread(resolve_ip_location, client_ip)
    if ip_loc and ip_loc != "未知属地":
        user.ip_location = ip_loc

    await db.commit()

    return await _issue_tokens(db, user, request, response=response)

@router.post("/refresh", response_model=TokenSchema)
async def refresh_token(
    request: Request,
    response: Response,
    req: Optional[RefreshTokenRequest] = None,
    db: AsyncSession = Depends(get_db),
):
    refresh_value = _read_refresh_token(request, req)
    if not refresh_value:
        raise HTTPException(status_code=401, detail="缺少刷新凭证，请重新登录")
    payload = decode_token(refresh_value)
    if not payload or payload.get("type") != "refresh":
        clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="无效或已过期的刷新凭证")

    user_id = payload.get("sub")
    query = select(User).where(User.id == user_id)
    res = await db.execute(query)
    user = res.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    if user.status == "banned":
        raise HTTPException(status_code=403, detail="该账号已被封禁")
    if user.status == "deactivated":
        raise HTTPException(status_code=403, detail="该账号已注销")
    if user.status == "deleting":
        raise HTTPException(status_code=403, detail="该账号已申请注销，正处于 10 天缓冲期；如需恢复请联系超级管理员")

    # 刷新令牌同样受版本号约束：改密/封禁后旧刷新凭证立即失效
    if int(payload.get("ver", 0) or 0) != int(user.token_version or 0):
        raise HTTPException(status_code=401, detail="刷新凭证已失效，请重新登录")

    # 轮换 + 重用检测。
    # 关键点：并发刷新必须「幂等收敛」而不是各发一个新令牌 ——
    # 两个标签页同时 401 时都会用同一个旧 Cookie 去续签，如果各自轮换出 T1/T2，
    # 浏览器最终只保留其中一个（由响应到达顺序决定），另一个就成了孤儿，
    # 等 access token 再次过期时用孤儿令牌续签必然 401 → 用户被动登出。
    # 现在的策略：命中的是「当前令牌」才轮换；命中的是「上一枚令牌」则原样返回服务端当前令牌。
    redis = get_redis()
    jti = payload.get("jti")
    sid = str(payload.get("sid") or jti or "")
    reused_token: Optional[str] = None
    # 内存降级模式下各 worker 键空间独立，强校验会导致随机 401，退化为签名+版本校验
    if redis and jti and not is_mock_redis():
        try:
            stored = await redis.get(f"rt:sid:{sid}") if sid else None
            prev = await redis.get(f"rt:prev:{sid}") if sid else None
            stored_s = stored.decode() if isinstance(stored, bytes) else stored
            prev_s = prev.decode() if isinstance(prev, bytes) else prev
            # 新格式存的是令牌原文（含 .），旧格式存的是 jti
            stored_is_token = bool(stored_s and "." in str(stored_s))

            if stored_is_token:
                if refresh_value != stored_s and prev_s != refresh_value:
                    raise HTTPException(status_code=401, detail="刷新凭证已失效或已被使用，请重新登录")
                if refresh_value != stored_s:
                    # 并发中的落后者：不轮换，直接把服务端当前令牌发回去，让两端收敛到同一个值
                    reused_token = str(stored_s)
            else:
                # 旧格式（按 jti 登记）或键缺失。
                # 键缺失时绝不 401：Redis 重启 / 内存淘汰 / 键过期都会让「所有在线用户」
                # 同时掉线，这正是「动不动就自动退出」的元凶。此时以 JWT 签名 + token_version
                # 为准放行，并立刻把本次令牌登记为当前值。
                if stored_s is None:
                    await redis.set(
                        f"rt:sid:{sid}",
                        refresh_value,
                        ex=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
                    )
                elif str(stored_s) != jti and prev_s != jti:
                    raise HTTPException(status_code=401, detail="刷新凭证已失效或已被使用，请重新登录")
        except HTTPException:
            raise
        except Exception:
            pass

    # 会话校验：被下线的设备不能再用旧 refresh 换新令牌。
    # 会话行已被清理时同样拒绝：否则「下线设备」的吊销状态会被
    # create_or_touch_session 懒重建一条无吊销标记的新行而复活。
    # 仅当 refresh 本身不带 sid（升级前的旧格式）时保持兼容放行。
    session = await get_session(db, sid) if sid else None
    if sid and session is None:
        raise HTTPException(status_code=401, detail="该登录会话已失效，请重新登录")
    if session and session.revoked_at is not None:
        raise HTTPException(status_code=401, detail="该设备已被下线，请重新登录")
    if session:
        await create_or_touch_session(db, sid, user.id, request)

    if reused_token:
        # 复用分支：不轮换刷新令牌，只续签 access token，
        # 并把 Cookie 纠正成服务端当前值，避免浏览器停在一个已失效的孤儿令牌上
        access_token = create_access_token(
            user.id, user.role, user.token_version or 0, sid=sid or None
        )
        await db.commit()
        set_refresh_cookie(response, reused_token, request)
        return TokenSchema(access_token=access_token, refresh_token=None)

    candidate = await issue_refresh_token(
        user.id,
        token_version=user.token_version or 0,
        session_id=sid or None,
        register_in_redis=False,
    )
    final_refresh = candidate

    if redis and sid:
        try:
            swapped = await redis.eval(
                _REFRESH_SWAP_LUA, 1, f"rt:sid:{sid}", refresh_value, candidate
            )
            if int(swapped or 0) == 1:
                # 本次轮换成功：旧令牌进入 60 秒宽限期，仅用于"收敛"，不会再产生新令牌
                # 旧令牌只在 60 秒内接受一次并发收敛；窗口过长等于给被盗令牌
                # 留出重放空间（此前是 600 秒，与注释不符）。
                await redis.set(f"rt:prev:{sid}", refresh_value, ex=60)
            else:
                winner = await redis.get(f"rt:sid:{sid}")
                winner_s = winner.decode() if isinstance(winner, bytes) else winner
                if winner_s:
                    # 已被其他并发请求抢先轮换：直接采用赢家的令牌
                    final_refresh = str(winner_s)
                else:
                    # 键不存在（例如刚清理过）：直接登记本次令牌
                    await redis.set(f"rt:sid:{sid}", candidate, ex=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400)
        except Exception as _exc:
            # Redis 异常时降级为普通登记，签名与版本号校验仍然生效
            print(f"[Auth][refresh-cas] 降级写入 sid={sid[:8]} err={type(_exc).__name__}: {str(_exc)[:160]}")
            try:
                await redis.set(f"rt:sid:{sid}", candidate, ex=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400)
            except Exception:
                pass

    access_token = create_access_token(
        user.id, user.role, user.token_version or 0, sid=sid or None
    )
    await db.commit()
    set_refresh_cookie(response, final_refresh, request)
    return TokenSchema(access_token=access_token, refresh_token=None)


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    req: Optional[RefreshTokenRequest] = None,
    db: AsyncSession = Depends(get_db),
):
    """退出当前设备：吊销对应会话，其他设备不受影响。"""
    refresh_value = _read_refresh_token(request, req)
    sid = sid_from_refresh(refresh_value) if refresh_value else None
    session = await get_session(db, sid) if sid else None
    if session:
        await revoke_session(db, session)
        await db.commit()
    clear_refresh_cookie(response)
    return {"message": "已退出当前设备"}


@router.get("/me", response_model=UserProfileResponse)
async def get_me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    redis = get_redis()
    remaining_quota = 0
    if redis:
        remaining_quota = await get_remaining_anon_quota(user.id, user.level, redis)

    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    if user.nickname_last_change_month != current_month:
        remaining_nick_changes = 3
    else:
        remaining_nick_changes = max(0, 3 - (user.nickname_change_count or 0))
    # 管理员在用户管理页重置后额外发放的昵称修改额度也要算进剩余次数
    remaining_nick_changes += max(0, int(getattr(user, "nickname_extra_quota", 0) or 0))

    followers_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.following_id == user.id))).scalar_one()
    following_cnt = (await db.execute(select(func.count()).select_from(Follow).where(Follow.follower_id == user.id))).scalar_one()
    posts_cnt = (await db.execute(select(func.count()).select_from(Post).where(Post.author_id == user.id, Post.status == "published"))).scalar_one()

    today = date.today()
    checkin_res = await db.execute(select(Checkin.id).where(Checkin.user_id == user.id, Checkin.checkin_date == today))
    has_checked_in = checkin_res.scalar_one_or_none() is not None

    return UserProfileResponse(
        id=user.id,
        username=user.username,
        nickname=user.nickname,
        email=user.email,
        avatar_url=user.avatar_url,
        bio=user.bio,
        role=user.role,
        status=user.status,
        level=user.level,
        experience=user.experience,
        equipped_title=user.equipped_title,
        active_days=user.active_days,
        created_at=user.created_at,
        remaining_anon_quota=remaining_quota,
        remaining_nickname_changes=remaining_nick_changes,
        followers_count=followers_cnt,
        following_count=following_cnt,
        posts_count=posts_cnt,
        is_following=False,
        is_blocked=False,
        is_blocked_by=False,
        dnd_enabled=bool(user.dnd_enabled),
        hide_following=bool(user.hide_following),
        hide_followers=bool(user.hide_followers),
        hide_favorites=bool(user.hide_favorites),
        hide_ip_location=bool(getattr(user, "hide_ip_location", False)),
        hide_online_status=bool(getattr(user, "hide_online_status", False)),
        # 能走到这里说明刚刚发生了一次认证请求，心跳键必然新鲜
        is_online=True,
        has_checked_in_today=has_checked_in,
        gender=getattr(user, "gender", "secret") or "secret",
        tech_stack=getattr(user, "tech_stack", "") or "",
        github_url=getattr(user, "github_url", "") or "",
        blog_url=getattr(user, "blog_url", "") or "",
        ip_location=getattr(user, "ip_location", "") or "",
        register_channel=getattr(user, "register_channel", "public") or "public",
        must_change_password=bool(getattr(user, "must_change_password", False)),
        open_post_in_new_tab=bool(getattr(user, "open_post_in_new_tab", False)),
        portal_mode=str(getattr(user, "portal_mode", "classic") or "classic"),
        email_verified=bool(getattr(user, "email_verified", False)),
        github_bound=bool(getattr(user, "github_id", None)),
        gitee_bound=bool(getattr(user, "gitee_id", None)),
    )

