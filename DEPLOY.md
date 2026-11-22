# 部署指南 (liaotian_V1)

## 环境要求

- Linux 服务器（Debian/Ubuntu 均可），1 核 2G 内存起步
- Docker + Docker Compose v2
- （可选）Cloudflare R2 对象存储用于图片与备份

## 快速部署

```bash
# 1. 克隆仓库
git clone https://github.com/Hyperion-WB/liaotian_V1.git
cd liaotian_V1

# 2. 生成环境配置
cp .env.example .env
# 必须修改：
#   - JWT_SECRET_KEY: 换成 64 位随机字符串（openssl rand -hex 32）
#   - 数据库密码 / 对象存储凭据按需填写
chmod 600 .env

# 3. 构建前端产物（nginx 挂载宿主机 frontend/dist，该目录不入库，必须先构建）
#    主机没有 Node.js 时会自动使用 node:20-alpine 容器构建
bash scripts/build_frontend.sh

# 4. 构建并启动（首次构建约 3~8 分钟，已内置国内镜像加速）
docker compose up -d --build

# 5. 验证
curl -f http://127.0.0.1:${WEB_PORT:-80}/api/healthz
```

管理员与基础分类由后端首次启动自动创建（**不会写入 matrix 测试账号或演示文章**）；
访问 `http://<服务器IP>:<WEB_PORT>/`（默认 80），账号 `admin`，
密码为 `.env` 里的 `BOOTSTRAP_ADMIN_PASSWORD`，首次登录强制修改。

> 目录挂载说明：容器只把 `backend/app` 挂载为代码目录，`backend/scripts`、`requirements.txt`、
> `Dockerfile` 等都在镜像里。改动这些文件后必须 `docker compose up -d --build backend`，
> 仅 `restart` 不会生效。

## 数据备份

默认使用**本地磁盘备份**（`scripts/backup_local.sh`）：PostgreSQL + uploads + 配置快照，
明确排除 `.env`，保留 14 天。手动执行：

```bash
bash scripts/backup_local.sh
```

R2 异地备份仍为可选项（`scripts/backup_r2.sh`），启用前需把 `.env` 从备份包剔除或加密，
并确认桶前缀私有不可公开读。重新启用的 crontab 写法：
```bash
(crontab -l 2>/dev/null; echo "30 3 * * * $(pwd)/scripts/backup_r2.sh >> /opt/backups/cron.log 2>&1") | crontab -
```
```

## 备份（本地磁盘）

已提供 `scripts/backup_local.sh`：`pg_dump` + `uploads` + 配置快照（**不含 `.env`**），默认保留 14 天。

```bash
# 手动执行一次
bash scripts/backup_local.sh

# 每 2 天 03:30 自动备份（本机已装好该 cron）
(crontab -l 2>/dev/null; echo "30 3 */2 * * /opt/liaotian/scripts/backup_local.sh >> /opt/backups/liaotian/cron.log 2>&1") | crontab -
```

服务已改为 **PostgreSQL 单一数据库**，SQLite 兼容代码与迁移分支已移除。

## 常用运维

| 操作 | 命令 |
|------|------|
| 查看容器状态 | `docker compose ps` |
| 查看后端日志 | `docker compose logs -f backend` |
| 重启全部服务 | `docker compose restart` |
| 更新部署（代码变更后） | `docker compose up -d --build` |

## 上线前必读

1. **HTTPS**：当前 `nginx.conf` 只监听 80。正式对外必须先配证书并补 443 server 块，否则密码与令牌明文传输。用 Cloudflare 代理时建议回源也走 HTTPS（Full/Strict）。
2. **Cloudflare 真实 IP**：`nginx.conf` 已内置 CF 网段与 `CF-Connecting-IP` 还原。若使用其他 CDN/反代，需要替换 `set_real_ip_from`。
3. **worker 数**：默认 2（`UVICORN_WORKERS`），启动迁移用 PostgreSQL 咨询锁、定时任务用 Redis 锁、WebSocket 走 Redis Pub/Sub。内存紧张可设 `UVICORN_WORKERS=1`。
4. **健康检查**：`/api/healthz` 会实际探测 DB 与 Redis；compose 已为 backend/nginx/redis 配置 healthcheck。
5. **CSP**：已启用严格脚本策略，主题初始化脚本外置为 `/theme-init.js`。新增第三方脚本（统计、客服等）需同步更新 `nginx/security_headers.conf`。
6. **敏感词管理**：后台「敏感词库管理」仅超级管理员可见，支持 JSON / TXT / CSV 一键导入，写入后立即生效（其余 worker 1 分钟内同步）。

## 常见问题

**Q: 启动后访问白屏？**
等前端镜像构建完成（`docker compose ps` 中 nginx 为 Up 状态）。

**Q: GitHub 登录不生效？**
在 `.env` 配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（GitHub → Settings → Developer settings → OAuth Apps，回调地址填 `http://<你的域名>/api/auth/github/callback`），然后 `docker compose up -d backend` 重建容器。

**Q: Gitee 登录如何开启？**
在 <https://gitee.com/oauth/applications> 创建应用，回调地址填 `https://<你的域名>/api/auth/gitee/callback`，然后把 `GITEE_CLIENT_ID` / `GITEE_CLIENT_SECRET` 写入 `.env`。未配置时登录框会自动隐藏 Gitee 按钮。

**Q: 注册验证码 / 找回密码邮件发不出去？**
在 `.env` 配置以下项后执行 `docker compose up -d backend`：

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USERNAME=no-reply@example.com
SMTP_PASSWORD=******
SMTP_FROM=极客社区 <no-reply@example.com>
SMTP_USE_SSL=1            # 465 端口；587 端口改为 0 并设置 SMTP_USE_STARTTLS=1
PUBLIC_SITE_URL=https://你的域名
EMAIL_VERIFICATION_REQUIRED=1
```

- SMTP 未配置时，系统会自动降级：注册不再强制验证码，验证码只写入后端日志（`docker compose logs -f backend` 可见），不会把注册锁死。
- 配置完成后，注册会强制校验邮箱验证码；「忘记密码」可通过邮箱验证码重置密码。
- 内网自测可临时打开 `EMAIL_DEV_EXPOSE_CODE=1`，让接口直接返回验证码；**生产环境务必保持 0**。

**Q: 如何开启人机校验（Cloudflare Turnstile）？**
在 Cloudflare 控制台创建 Turnstile 站点（域名填你的社区域名），然后写入 `.env`：

```bash
TURNSTILE_SITE_KEY=0x4AAAAAAA...
TURNSTILE_SECRET_KEY=0x4AAAAAAA...
CAPTCHA_LOGIN_AFTER_FAILURES=3   # 密码错误 3 次后登录要求人机校验
CAPTCHA_EMAIL_AFTER_SENDS=5      # 同一 IP 每小时发信 5 次后要求人机校验
```

生效范围：注册、连续密码错误后的登录、频繁发送邮箱验证码。两个 Key 任一为空时自动关闭，不会影响现有流程；Cloudflare 校验接口不可用时采用 fail-open，避免全站无法登录。

**Q: 用户在哪里查看/下线自己的登录设备？**
个人主页 → 安全 → 「登录设备」。列表按最近活跃排序，可单台下线或一键下线其他设备；下线后该设备的 refresh token 立即失效（access token 最多 2 小时后自然过期）。

**Q: 图片想存本地而不是 R2？**
`.env` 中设置 `STORAGE_TYPE=local` 即可，上传目录由 compose 卷持久化。
