# 极客社区 (Liaotian Geek Community) 4.0

> 纯曜石黑白极简主义 · 现代高并发 · 低内存克制 · 沉浸式工程美学社区

[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-Ready-blue.svg)](docker-compose.yml)
[![FastAPI](https://img.shields.io/badge/Backend-FastAPI%20Python%203.11-009688.svg)](https://fastapi.tiangolo.com/)
[![React 19](https://img.shields.io/badge/Frontend-React%2019%20%2B%20Vite-61DAFB.svg)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Style-Tailwind%20Industrial%20Dark-38B2AC.svg)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

---

## 🌟 核心特性与设计

- **纯黑白冷曜石工业美学**：弃用一切花哨杂色与高饱和 Emoji，采用高质感钛灰黑白层次、精密字阶与 Apple HIG 物理弹性微动效。
- **300MB 物理内存极致克制 + Swap 弹性溢出**：全容器物理 RAM 严格限制为 300MB（Nginx 25MB + 后端 130MB + PostgreSQL 110MB + Redis 35MB），任何突发负载自动平滑溢出至 Linux Swap 换页运行，彻底杜绝小内存服务器 OOM 崩溃。
- **六级权限与见习晋升考核体系**：
  - Lv.0 见习会员 (5天活跃晋升) ➔ Lv.1 正式会员 ➔ Lv.2 进阶极客 ➔ Lv.3 资深先锋 ➔ Lv.4 核心领航 ➔ Lv.5~6 社区导师与超管；
  - 每日打卡签到 (+5 EXP) 与活跃度天数自动晋升。
- **用户名/昵称分离与社交风控体系**：
  - **用户名**：注册后全局唯一、不可修改；
  - **昵称**：每月严格限制修改最多 3 次，保护社交信誉；
  - **黑名单与免打扰**：一键将骚扰用户加入个人黑名单（自动拦截私信、禁止访问动态、屏蔽系统通知），支持随时开启全局免打扰 (DND) 模式。
- **首页「全站发现」与「关注动态」双通道**：
  - 支持多技术标签（`#FastAPI`、`#React 19`、`#架构设计` 等）一键过滤；
  - 创作者关注动态聚合流，空状态智能引导先锋榜互粉。
- **全链路社交通知中心 2.0**：
  - 4 档分段抽屉（全部 / 互动 / 关注 / 系统）；
  - 关注、点赞、发评、楼中楼回复全场景即时消息触达，支持一键已读与点击跳转主页。
- **极客荣誉成就勋章墙**：
  - 6 大钛金属几何勋章（新人启程、持之以恒、独立创作者、社区焦点、社交先锋、社区守护者），在个人主页与公开名片双向动态展示达成进度。
- **即时私聊与多选高级投票**：
  - 毫秒级 WebSocket 私聊、未读红点与撤回机制；
  - 文章内嵌高级投票组件，支持单选/多选投票与实时票数占比动态计算。

---

## 🚀 服务器极速部署 (推荐)

本项目已**全面预置中国大陆镜像源加速**（Debian 清华源、Python Pip 清华源与阿里源备选、NPM npmmirror 淘宝源、Alpine 清华源），服务器无需预装 Node.js 或 Python，只需几条命令即可全自动一键起跑：

### 方式一：一键脚本极速部署 (最简)

在你的 Linux 服务器控制台执行以下几条命令：

```bash
# 1. 克隆代码仓库
git clone https://github.com/Hyperion-WB/liaotian_V1.git
cd liaotian_V1

# 2. 赋予脚本执行权限并启动一键部署
chmod +x deploy.sh
./deploy.sh
```

脚本将全自动完成：检测环境、生成 `.env`（随机 JWT 密钥与数据库口令）、编译前端、构建后端、启动 PostgreSQL/Redis；管理员与基础分类由后端首次启动自动创建（**不再写入测试账号与演示文章**）。

> 首次执行后请编辑 `.env` 补齐 `PUBLIC_SITE_URL`、`WEB_PORT`，以及需要的 `SMTP_*`、`TURNSTILE_*`、`GITHUB_*`/`GITEE_*`，然后 `docker compose up -d backend` 生效。

---

### 方式二：Docker Compose 手动启动

```bash
# 1. 克隆代码并进入目录
git clone https://github.com/Hyperion-WB/liaotian.git
cd liaotian_V1

# 2. 复制环境变量并至少填写 WEB_PORT / PUBLIC_SITE_URL
cp .env.example .env
vi .env

# 3. 先构建前端产物（nginx 挂载的是宿主机 frontend/dist，缺失会白屏）
bash scripts/build_frontend.sh

# 4. 后台构建并启动全部服务（管理员与分类由后端自动创建）
docker compose up -d --build
```

---

## 🔑 默认登录账号

服务启动后，在浏览器访问 `http://<你的服务器IP>:<WEB_PORT>/`（`WEB_PORT` 默认 80）：
- **超级管理员**: `admin`
- **初始密码**: `.env` 中的 `BOOTSTRAP_ADMIN_PASSWORD`（未配置时随机生成并打印到日志），首次登录会强制修改

> ⚠️ 生产环境请先把 `BOOTSTRAP_ADMIN_PASSWORD` 改成随机强口令，并在首次登录后立即修改。
>
> 需要演示账号（matrix）与示例文章时，显式执行：
> `SEED_DEMO_DATA=1 docker compose exec -T backend python scripts/seed_data.py`

---

## 🛠️ 常用运维命令

| 操作 | 对应命令 |
| :--- | :--- |
| **查看所有容器运行状态** | `docker compose ps` |
| **查看全站实时日志** | `docker compose logs -f` |
| **查看后端 API 运行日志** | `docker compose logs -f backend` |
| **重启所有服务** | `docker compose restart` |
| **平滑重载 Nginx 配置** | `docker compose exec nginx nginx -s reload` |
| **停止并退出所有容器** | `docker compose down` |
| **执行定时数据库备份** | `bash scripts/backup.sh` |

---

## 📁 核心目录结构

```text
liaotian/
├── backend/                  # FastAPI 异步后端
│   ├── app/
│   │   ├── models/           # SQLAlchemy 数据库实体
│   │   ├── routers/          # 业务路由接口 (auth, users, posts, comments, polls, chat, admin)
│   │   ├── schemas/          # Pydantic 请求体与响应模型
│   │   └── services/         # 敏感词扫描、等级晋升、限流服务
│   ├── scripts/              # 数据库种子填充脚本
│   └── Dockerfile            # 后端生产环境 Dockerfile (内置清华/阿里源)
├── frontend/                 # React 19 + Vite + Tailwind CSS 前端
│   ├── src/
│   │   ├── components/       # 纯黑白极简组件库 (Navbar, Modals, Drawer, LevelBadge 等)
│   │   └── pages/            # 页面视图 (Home, PostDetail, Editor, Profile, Admin)
│   └── Dockerfile            # 前端多阶段构建 Dockerfile (内置 npmmirror 源)
├── nginx/
│   ├── nginx.conf            # Nginx 生产反向代理、限流与静态缓存配置
│   └── ssl/                  # HTTPS 证书挂载目录
├── scripts/
│   ├── backup.sh             # 自动化数据与附件备份脚本
│   └── init_admin.py         # 独立超管初始化脚本
├── deploy.sh                 # Linux 服务器一键自动化部署脚本
├── docker-compose.yml        # Docker 编排配置
├── .env.example              # 环境变量配置模板
└── README.md                 # 项目文档
```

---

## 🛠 本地开发

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

> 开发模式可设置 `ENVIRONMENT=development`，未配置 `JWT_SECRET_KEY` 时会生成进程级临时密钥。

## 🔐 部署前必读

- `JWT_SECRET_KEY` **必须**配置随机值（`openssl rand -hex 32`），生产环境缺失会拒绝启动
- `BOOTSTRAP_ADMIN_PASSWORD` 留空时首次启动随机生成并打印到日志，首次登录强制改密
- 生产保持 `ENABLE_API_DOCS` 关闭；`CORS_ORIGINS` 同源部署可留空
- 上传目录不要暴露可执行权限；HTTPS 与反向代理限流请按 `nginx/nginx.conf` 配置
- 仓库不包含任何真实用户数据、备份或密钥

## 🤝 贡献

欢迎提交 Issue 与 PR：

- 先读 [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告
- 参与讨论即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- CI 会跑后端的语法/静态检查与前端的 `tsc + oxlint + build`

## 📦 第三方资源

小游戏、象棋规则、成语库、诗词数据、字体与图标的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 📄 License
Released under the [MIT License](LICENSE).
