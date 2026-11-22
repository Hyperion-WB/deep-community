from typing import Optional
from uuid import UUID
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db, get_redis
from app.core.security import decode_token
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

async def get_current_user_optional(
    token: Optional[str] = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> Optional[User]:
    if not token:
        return None
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        return None
    
    user_id_str = payload.get("sub")
    if not user_id_str:
        return None

    try:
        user_uuid = UUID(user_id_str)
    except ValueError:
        return None

    query = select(User).where(User.id == user_uuid)
    result = await db.execute(query)
    user = result.scalar_one_or_none()
    if not user:
        return None

    # 令牌版本校验：改密 / 封禁会自增 token_version，此处使旧令牌立即失效
    token_ver = int(payload.get("ver", 0) or 0)
    if token_ver != int(getattr(user, "token_version", 0) or 0):
        return None

    # 在线心跳：以"90 秒内有任意认证请求"作为在线判定。
    # 前端登录态会每 20 秒轮询一次未读数，因此正常浏览时心跳足够密集；
    # 后台标签页被浏览器节流到约 1 次/分钟时仍在 90 秒窗口内，不会误判离线。
    # 关掉页面后最多 90 秒就会转为离线（此前 300 秒会让"已关闭"的账号长时间显示在线）。
    try:
        redis = get_redis()
        if redis:
            await redis.set(f"online:user:{user.id}", "1", ex=90)
    except Exception:
        pass

    return user

# 默认口令未修改时仍允许访问的端点（改密、自查、登出、刷新）
_PASSWORD_FLOW_SUFFIXES = (
    "/users/me/password",
    "/auth/me",
    "/auth/logout",
    "/auth/refresh",
)

async def get_current_user(
    request: Request,
    user: Optional[User] = Depends(get_current_user_optional)
) -> User:
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="需要登录后方可操作",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.status == "banned":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="该账号已被封禁")
    if user.status == "deactivated":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="该账号已注销")
    # 首次登录使用默认口令：强制改密，避免长期以弱口令在线
    if getattr(user, "must_change_password", False):
        path = request.url.path.rstrip("/")
        if not path.endswith(_PASSWORD_FLOW_SUFFIXES):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="当前账号仍在使用初始密码，请先修改密码后再继续操作",
            )
    return user

async def get_current_active_user(
    user: User = Depends(get_current_user)
) -> User:
    """仅正式会员可用 (见习生拦截)"""
    if user.status == "probation":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前为见习会员 (完成 5 天活跃后自动转正解锁全部特权)"
        )
    return user

ADMIN_ROLES = {"super_admin", "admin", "moderator", "auditor"}

def is_admin_role(role: Optional[str]) -> bool:
    return role in ADMIN_ROLES

async def get_current_admin(
    user: User = Depends(get_current_user)
) -> User:
    if not is_admin_role(user.role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return user

async def get_current_super_admin(
    user: User = Depends(get_current_user)
) -> User:
    """高层管理接口：超级管理员与管理员均可访问（如运营看板）"""
    if user.role not in {"super_admin", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要最高管理员 (Super Admin) 权限")
    return user


async def get_current_root_admin(
    user: User = Depends(get_current_user)
) -> User:
    """仅超级管理员本人：用于角色授予、彻底删号等不可逆高危操作"""
    if user.role != "super_admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="该操作仅限超级管理员 (Super Admin) 本人执行"
        )
    return user

async def get_current_moderator(
    user: User = Depends(get_current_user)
) -> User:
    if user.role not in {"super_admin", "admin", "moderator"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要板块版主 (Moderator) 及以上权限")
    return user
