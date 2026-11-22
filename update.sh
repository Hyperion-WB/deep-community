#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo " 🚀 正在执行极客社区一键全自动更新..."
echo "=========================================="

echo "⏰ 校准服务器北京时间与 NTP 授时..."
if command -v timedatectl &> /dev/null; then
    timedatectl set-timezone Asia/Shanghai 2>/dev/null || true
    timedatectl set-ntp true 2>/dev/null || true
fi
if command -v chronyc &> /dev/null; then
    chronyc makestep 2>/dev/null || true
elif command -v ntpdate &> /dev/null; then
    ntpdate -u ntp.aliyun.com 2>/dev/null || true
fi

echo "📥 [1/4] 拉取远端最新代码..."
git fetch origin main || true
git reset --hard origin/main || git pull origin main || true

echo "📦 [2/4] 安装前端依赖并构建生产包..."
# 注意：nginx 容器挂载的是宿主机 frontend/dist，且该目录不入库，
# 因此每次更新都应重新构建，否则会出现"代码已更新但页面没变/白屏"。
if bash "$SCRIPT_DIR/scripts/build_frontend.sh"; then
    echo "✅ 前端产物已更新"
else
    echo "⚠️ 前端构建失败：若 frontend/dist 不为空将沿用旧产物，否则页面会白屏，请手动执行 bash scripts/build_frontend.sh"
fi

echo "🐍 [3/4] 检查并更新后端依赖..."
if [ -f "backend/requirements.txt" ]; then
    if [ -d "venv" ]; then
        source venv/bin/activate 2>/dev/null || true
        pip install -r backend/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet || true
    elif [ -d "backend/venv" ]; then
        source backend/venv/bin/activate 2>/dev/null || true
        pip install -r backend/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet || true
    fi
fi

echo "🔄 [4/4] 智能重启服务..."
if command -v docker &> /dev/null && [ -f "docker-compose.yml" ]; then
    echo "🐳 重新加载 Docker 容器挂载与服务..."
    (docker compose up -d 2>/dev/null || docker-compose up -d 2>/dev/null) || true
    (docker compose restart backend nginx 2>/dev/null || docker-compose restart backend nginx 2>/dev/null) || true
fi

if systemctl is-active --quiet liaotian-backend 2>/dev/null; then
    systemctl restart liaotian-backend || true
elif systemctl is-active --quiet liaotian 2>/dev/null; then
    systemctl restart liaotian || true
elif command -v supervisorctl &> /dev/null; then
    (supervisorctl restart liaotian-backend 2>/dev/null || supervisorctl restart liaotian 2>/dev/null || supervisorctl restart all 2>/dev/null) || true
fi

# 尝试让 nginx 重新加载最新静态资源
if command -v nginx &> /dev/null; then
    nginx -s reload 2>/dev/null || systemctl reload nginx 2>/dev/null || true
fi

echo "=========================================="
echo " 🎉 更新完成！前端构建成功，服务已重启！"
echo " 💡 请按 Ctrl+F5 刷新浏览器体验最新版本！"
echo "=========================================="
