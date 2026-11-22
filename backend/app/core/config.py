from typing import Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    PROJECT_NAME: str = "Community Platform"
    VERSION: str = "4.0.0"
    API_V1_STR: str = "/api"
    ENVIRONMENT: str = "production"

    # 数据库 (默认使用本地轻量 SQLite 异步数据库，具备即开即用零配置特性)
    DATABASE_URL: str = "postgresql+asyncpg://app_user:app_pass@localhost:5432/community_db"

    # Redis (置空自动平滑启用内存 Mock，亦可填入 redis://localhost:6379/0)
    REDIS_URL: str = ""

    # 安全与跨域（生产默认仅允许同源；如前后端分域请在 .env 里配置逗号分隔白名单）
    CORS_ORIGINS: str = ""
    ENABLE_API_DOCS: bool = False
    # 首次部署的超级管理员初始口令（可用环境变量覆盖；首次登录会被强制改密）
    # 初始超管口令：留空则启动时随机生成并打印一次（首次登录强制改密）
    BOOTSTRAP_ADMIN_PASSWORD: str = ""
    # 注销缓冲期：用户自助注销 / 管理员删除后，账号保留多少天可恢复
    DELETION_GRACE_DAYS: int = 10

    # JWT 认证配置
    # 必填：生成方式 openssl rand -hex 32。生产环境缺失会直接拒绝启动，避免所有实例共用默认密钥。
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 120        # 2 小时
    # 刷新令牌有效期（滑动续期）：每次成功续签都会重置，只要 30 天内访问过一次就不会掉线。
    # 之前是 7 天，对「登录一次长期在线」的预期偏短。
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # 文件与对象存储配置 (支持本地存储或一键无缝切换 Cloudflare R2 / AWS S3 / MinIO)
    STORAGE_TYPE: str = "local"                   # local 或 s3
    # 对象存储总开关：当前只落本地磁盘，保持 False（接口与代码全保留）。
    # 换好新服务商后：填完 S3_* 配置，再把 S3_ENABLED 置 1 即可重新启用。
    S3_ENABLED: bool = False
    # 镜像双写：本地为主存储，S3/R2 作为备份与缺失回源（仅 STORAGE_TYPE=local 时生效）
    S3_MIRROR: bool = False
    UPLOAD_DIR: str = "./uploads"
    MAX_IMAGE_SIZE_MB: int = 5
    # 动图 GIF 单独放宽：GIF 不做转码，体积通常远大于静态图
    MAX_GIF_SIZE_MB: int = 20
    S3_ENDPOINT: Optional[str] = None             # Cloudflare R2: https://<account_id>.r2.cloudflarestorage.com
    S3_ACCESS_KEY: Optional[str] = None           # R2 Access Key ID
    S3_SECRET_KEY: Optional[str] = None           # R2 Secret Access Key
    S3_BUCKET: Optional[str] = None               # 存储桶名称，如 community-images
    S3_PUBLIC_DOMAIN: Optional[str] = None         # 绑定的公开访问域名，如 https://img.yourdomain.com
    S3_REGION: str = "auto"                       # 区域，R2 填写 auto 即可

    # 社区等级与权限配置
    PROBATION_ACTIVE_DAYS_REQUIRED: int = 5       # 见习转正所需独立活跃天数

    # GitHub OAuth 登录（留空则禁用 GitHub 登录入口）
    GITHUB_CLIENT_ID: str = ""
    GITHUB_CLIENT_SECRET: str = ""
    PUBLIC_SITE_URL: str = ""                     # 可选：显式指定站点对外地址，用于 OAuth 回调

    # Gitee OAuth 登录（留空则禁用 Gitee 登录入口）
    GITEE_CLIENT_ID: str = ""
    GITEE_CLIENT_SECRET: str = ""

    # 邮箱服务（SMTP）：未配置时邮件只写入服务端日志，便于本地/内网自测
    SMTP_HOST: str = ""
    SMTP_PORT: int = 465
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""                           # 留空则取 SMTP_USERNAME
    SMTP_USE_SSL: bool = True                     # 465 端口用 SSL；587 端口请置 0 并开启 STARTTLS
    SMTP_USE_STARTTLS: bool = False
    SMTP_TIMEOUT_SECONDS: int = 10

    # 邮箱验证码策略
    EMAIL_CODE_TTL_SECONDS: int = 600             # 验证码有效期 10 分钟
    EMAIL_CODE_RESEND_SECONDS: int = 60           # 同一邮箱重发冷却
    EMAIL_CODE_MAX_ATTEMPTS: int = 5              # 单码最多校验失败次数
    EMAIL_VERIFICATION_REQUIRED: bool = True      # 开启后注册必须通过邮箱验证码（SMTP 未配置时自动降级放行）
    EMAIL_DEV_EXPOSE_CODE: bool = False           # 未配置 SMTP 时是否把验证码直接返回给前端（仅限内网自测）

    # Cloudflare Turnstile 人机校验（留空则关闭）
    TURNSTILE_SITE_KEY: str = ""
    TURNSTILE_SECRET_KEY: str = ""
    CAPTCHA_LOGIN_AFTER_FAILURES: int = 3         # 同一账号第 N 次密码错误后，登录需要人机校验
    CAPTCHA_EMAIL_AFTER_SENDS: int = 5            # 同一 IP 每小时发送 N 封验证码后，需要人机校验
    CAPTCHA_EMAIL_WINDOW_SECONDS: int = 3600

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings = Settings()
