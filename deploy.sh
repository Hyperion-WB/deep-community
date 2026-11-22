#!/usr/bin/env bash
# ==============================================================================
# 极客社区 (Liaotian Community) - 极速一键部署脚本 (300MB RAM + Swap 专属优化)
# 适用系统: Ubuntu / Debian / CentOS / Rocky Linux / macOS
# ==============================================================================
set -e

echo "========================================================"
echo " 正在启动极客社区一键部署程序 (300MB 物理内存 + Swap 版)..."
echo " 镜像源已全部加速: 清华大学开源镜像站 / 阿里云 / npmmirror"
echo "========================================================"

# 1. 检查 Docker 及 Docker Compose
if ! command -v docker &> /dev/null; then
    echo "[错误] 未检测到 Docker，请先安装 Docker 后重试: curl -fsSL https://get.docker.com | bash"
    exit 1
fi

DOCKER_COMPOSE_CMD=""
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker-compose"
else
    echo "[错误] 未检测到 docker compose 插件或 docker-compose 命令行工具"
    exit 1
fi

# 检查宿主机 Swap 状态
if command -v free &> /dev/null; then
    SWAP_MB=$(free -m | awk '/Swap:/ {print $2}')
    if [ -n "$SWAP_MB" ] && [ "$SWAP_MB" -gt 0 ]; then
        echo "[内存与Swap] 检测到系统已配置 ${SWAP_MB}MB Swap 空间！"
        echo "[内存与Swap] 容器物理内存严格限制为 300MB，超额负载将自动流畅溢出至 Swap 运行。"
    else
        echo "[内存与Swap] 提示: 当前未检测到系统 Swap，如物理内存极度紧张建议保持 Swap 开启。"
    fi
fi

# 2. 准备环境变量配置
if [ ! -f ".env" ]; then
    echo "[配置] 未检测到 .env 配置文件，自动从 .env.example 复制生成..."
    cp .env.example .env
    # 随机生成 64 位安全 JWT 密钥
    if command -v openssl &> /dev/null; then
        RANDOM_SECRET=$(openssl rand -hex 32)
        sed -i "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$RANDOM_SECRET/" .env 2>/dev/null || true
    fi

    # 数据库口令同样随机化，并同步 DATABASE_URL，避免沿用示例里的弱口令
    if command -v openssl &> /dev/null; then
        RANDOM_DB_PASS=$(openssl rand -hex 16)
        DB_USER=$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2)
        DB_NAME=$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2)
        DB_USER=${DB_USER:-app_user}
        DB_NAME=${DB_NAME:-community_db}
        sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${RANDOM_DB_PASS}|" .env
        sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql+asyncpg://${DB_USER}:${RANDOM_DB_PASS}@db:5432/${DB_NAME}|" .env
        echo "[配置] 已随机生成数据库口令并同步 DATABASE_URL"
    fi
    echo "[配置] .env 配置文件已就绪，请按需填写域名/SMTP/OAuth 等密钥后重新执行。"
fi

# 3. 准备挂载目录
mkdir -p uploads nginx/ssl

# 3.5 构建前端产物
# nginx 容器挂载的是宿主机 frontend/dist（该目录不入库），必须先构建，否则页面白屏
echo "[构建] 正在构建前端生产产物（无 Node 主机将自动使用 Docker 构建）..."
if ! bash scripts/build_frontend.sh; then
    echo "[错误] 前端构建失败，请检查网络后手动执行: bash scripts/build_frontend.sh"
    exit 1
fi

# 4. 构建并启动容器群组 (国内镜像加速构建)
echo "[构建] 正在使用国内镜像源自动构建并启动服务 (物理内存上限 300MB)..."
$DOCKER_COMPOSE_CMD up -d --build

# 5. 等待数据库与服务健康就绪
echo "[检查] 正在等待数据库与后端服务就绪 (约 6 秒)..."
sleep 6

# 6. 初始数据由后端首次启动自动创建（admin + 基础分类）
#    注意：不再自动写入 matrix 测试账号与演示文章，避免污染生产库。
#    如确需演示数据：SEED_DEMO_DATA=1 docker compose exec -T backend python scripts/seed_data.py
echo "[初始化] 管理员与基础分类由后端启动时自动创建（不写入演示数据）"

echo "========================================================"
echo " 🎉 极客社区 4.0 部署成功！"
echo ""
echo " 访问地址: http://<你的服务器IP或域名>:${WEB_PORT:-见 .env WEB_PORT}/"
BOOT_PASS=$(grep -E '^BOOTSTRAP_ADMIN_PASSWORD=' .env 2>/dev/null | head -1 | cut -d= -f2)
echo " 超管账号: admin"
echo " 超管初始密码: ${BOOT_PASS:-（见后端启动日志随机口令）}（首次登录强制改密）"
echo ""
echo " 常用运维命令:"
echo " - 查看实时日志: $DOCKER_COMPOSE_CMD logs -f"
echo " - 查看内存与Swap占用: docker stats --no-stream"
echo " - 停止所有服务: $DOCKER_COMPOSE_CMD down"
echo " - 重启所有服务: $DOCKER_COMPOSE_CMD restart"
echo "========================================================"
