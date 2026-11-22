# 极客社区 · Deep Community

一个可自托管的社区平台：文章与讨论、群聊与私信、小游戏与棋类对战、成就体系、后台管理。

[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-Ready-blue.svg)](docker-compose.yml)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI%20%2B%20Python%203.11-009688.svg)](https://fastapi.tiangolo.com/)
[![React](https://img.shields.io/badge/Frontend-React%2019%20%2B%20Vite-61DAFB.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Style-Tailwind%20CSS-38B2AC.svg)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

---

## 技术栈

| 层 | 选型 |
| :--- | :--- |
| 后端 | FastAPI · SQLAlchemy 2.0 (async) · Pydantic v2 |
| 前端 | React 19 · TypeScript · Vite · Tailwind CSS |
| 数据 | PostgreSQL · Redis（可降级为内存实现） |
| 实时 | WebSocket（私聊 / 群聊 / 对局同步） |
| 部署 | Docker Compose · Nginx 反代与限流 |

## 快速开始（Docker）

```bash
git clone https://github.com/Hyperion-WB/deep-community.git
cd deep-community

cp .env.example .env
# 必填：JWT_SECRET_KEY=$(openssl rand -hex 32)
# 建议同时设置：POSTGRES_PASSWORD、WEB_PORT、PUBLIC_SITE_URL

# nginx 挂载的是宿主机 frontend/dist，缺失会白屏
bash scripts/build_frontend.sh

docker compose up -d --build
```

启动后访问 `http://<服务器IP>:<WEB_PORT>/`（默认 80）。

- 管理员账号：`admin`
- 初始口令：`BOOTSTRAP_ADMIN_PASSWORD`；未配置时启动日志会打印一个随机口令
- 首次登录会强制修改口令

需要演示数据时显式执行：

```bash
SEED_DEMO_DATA=1 docker compose exec -T backend python scripts/seed_data.py
```

也可以使用一键脚本（自动检测环境、生成 `.env`、构建并启动）：

```bash
chmod +x deploy.sh && ./deploy.sh
```

## 本地开发

后端（Python 3.11）：

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

前端（Node 20）：

```bash
cd frontend
npm ci
npm run dev
```

> 开发模式可设置 `ENVIRONMENT=development`；未配置 `JWT_SECRET_KEY` 时会生成进程级临时密钥（重启后登录态失效）。

## 关键配置

| 变量 | 说明 |
| :--- | :--- |
| `JWT_SECRET_KEY` | 必填，`openssl rand -hex 32`；生产缺失会拒绝启动 |
| `POSTGRES_PASSWORD` | 数据库口令，部署前务必修改 |
| `WEB_PORT` | Nginx 对外端口，默认 80 |
| `PUBLIC_SITE_URL` | 站点完整地址，用于生成分享/回调链接 |
| `ENABLE_API_DOCS` | 生产默认关闭 `/api/docs` |
| `CORS_ORIGINS` | 前后端同源部署可留空；分域时填逗号分隔白名单 |
| `STORAGE_TYPE` | `local`（默认）或 `s3`，可接 R2 / MinIO |
| `SMTP_*` / `TURNSTILE_*` / `GITHUB_*` / `GITEE_*` | 邮件、人机校验、第三方登录，按需配置 |

完整列表与默认值见 [`.env.example`](.env.example)。

## 常用运维

| 操作 | 命令 |
| :--- | :--- |
| 查看容器状态 | `docker compose ps` |
| 查看全站日志 | `docker compose logs -f` |
| 查看后端日志 | `docker compose logs -f backend` |
| 重启全部服务 | `docker compose restart` |
| 重载 Nginx | `docker compose exec nginx nginx -s reload` |
| 停止服务 | `docker compose down` |
| 备份数据库与附件 | `bash scripts/backup.sh` |

## 目录结构

```text
deep-community/
├── backend/                  # FastAPI 异步后端
│   ├── app/
│   │   ├── models/           # SQLAlchemy 实体
│   │   ├── routers/          # 业务路由（auth/users/posts/chat/admin...）
│   │   ├── services/         # 敏感词、等级、存储、游戏规则等
│   │   ├── core/             # 配置、迁移、时区、安全
│   │   └── data/             # 只读静态数据（成语库、诗库）
│   ├── scripts/              # 初始化与数据脚本
│   └── Dockerfile
├── frontend/                 # React 19 + Vite + Tailwind
│   ├── src/components/       # 通用组件
│   ├── src/pages/            # 页面
│   └── Dockerfile
├── nginx/                    # 反向代理、限流、安全头
├── scripts/                  # 构建 / 备份 / 恢复脚本
├── docs/                     # 接口文档
├── docker-compose.yml
├── deploy.sh
└── .env.example
```

## 安全

- 生产环境必须配置随机 `JWT_SECRET_KEY`，不要使用仓库中的任何占位值
- 首次登录强制改密；管理员重置口令为随机临时口令
- 生产关闭 API 文档，按需配置 CORS 白名单
- 上传目录不可执行，全站 HTTPS，Nginx 已内置限流与安全头
- 漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开 Issue

## 贡献

欢迎 Issue 与 PR：

- 先读 [CONTRIBUTING.md](CONTRIBUTING.md)
- 参与讨论即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- CI 会执行后端语法/静态检查与前端 `tsc + oxlint + build`
- 合并需要维护者审核通过

## 第三方资源

小游戏、象棋规则、成语库、诗词数据、字体与图标的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## License

Released under the [MIT License](LICENSE).
