from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Union
from jose import jwt, JWTError
import asyncio
import bcrypt
import uuid
from app.core.config import settings


async def verify_password_async(plain_password: str, hashed_password: str) -> bool:
    """线程池校验密码：bcrypt 是纯 CPU 操作，放在事件循环里会阻塞整个 worker。"""
    return await asyncio.to_thread(verify_password, plain_password, hashed_password)


async def get_password_hash_async(password: str) -> str:
    """线程池生成密码哈希，避免登录/注册高峰卡死事件循环。"""
    return await asyncio.to_thread(get_password_hash, password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """验证明文密码与哈希值"""
    try:
        pw_bytes = plain_password.encode('utf-8')[:72]
        hash_bytes = hashed_password.encode('utf-8')
        return bcrypt.checkpw(pw_bytes, hash_bytes)
    except Exception:
        return False

def get_password_hash(password: str) -> str:
    """生成 Bcrypt 密码哈希"""
    pw_bytes = password.encode('utf-8')[:72]
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(pw_bytes, salt).decode('utf-8')

def create_access_token(
    subject: Union[str, Any],
    role: str,
    token_version: int = 0,
    expires_delta: Optional[timedelta] = None,
    sid: Optional[str] = None,
) -> str:
    """生成短效 Access Token

    令牌内携带 token_version：改密 / 封禁后服务端自增该版本号，
    所有旧令牌（含 refresh）立即失效，实现"可吊销"。
    """
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)

    to_encode = {
        "exp": expire,
        "sub": str(subject),
        "role": role,
        "type": "access",
        "ver": int(token_version or 0)
    }
    if sid:
        to_encode["sid"] = str(sid)
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt

def create_refresh_token(
    subject: Union[str, Any],
    expires_delta: Optional[timedelta] = None,
    token_version: int = 0,
    session_id: Optional[str] = None,
) -> str:
    """生成长效 Refresh Token（携带唯一 jti，供服务端轮换与重用检测）

    sid 为设备会话 ID：刷新轮换时保持不变，用于「登录设备」列表与单设备下线。
    """
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    to_encode = {
        "exp": expire,
        "sub": str(subject),
        "type": "refresh",
        "ver": int(token_version or 0),
        "jti": uuid.uuid4().hex,
        "sid": str(session_id or uuid.uuid4().hex),
    }
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt

def decode_token(token: str) -> Optional[dict]:
    """解码并校验 Token"""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


async def issue_refresh_token(
    subject: Union[str, Any],
    token_version: int = 0,
    expires_delta: Optional[timedelta] = None,
    session_id: Optional[str] = None,
    register_in_redis: bool = True,
) -> str:
    """签发 refresh token，并按「会话」登记当前有效 jti。

    存储设计（重要）：
    - 旧实现按 jti 建键并设置 TTL，落在 Redis 的可淘汰数据集里，
      一旦缓存压力触发 volatile-lru，登录态会被随机淘汰；
    - 现在按 sid 建键且**不设 TTL**（不属于淘汰候选），每个设备只占一个键；
      过期会话由定时任务按 user_sessions.created_at 统一回收；
    - 刷新轮换时覆盖同一 sid 的 jti，旧 jti 立即失效，天然完成重用检测。

    Redis 不可用时降级为纯签名 + 版本校验。
    """
    token = create_refresh_token(subject, expires_delta, token_version, session_id=session_id)
    if not register_in_redis:
        # 由调用方负责用 CAS 原子写入（并发刷新只有一方能成功轮换）
        return token
    try:
        from app.core.database import get_redis
        redis = get_redis()
        if redis:
            payload = decode_token(token) or {}
            sid = payload.get("sid")
            if sid:
                # 存「令牌原文」而不是 jti：
                # 并发刷新（多标签页同时 401）时，服务端可以把同一个当前令牌原样返回，
                # 让两个响应写下同一个 Cookie，避免各自轮换出两个互斥令牌、其中一个随后 401。
                # 与刷新令牌同寿命（7 天），避免键永久驻留；键过期后走"缺失放行"分支，
                # 不会把用户踢下线
                await redis.set(f"rt:sid:{sid}", token, ex=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400)
    except Exception:
        pass
    return token
