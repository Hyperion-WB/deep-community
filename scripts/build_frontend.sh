#!/usr/bin/env bash
# ==============================================================================
# 前端产物构建脚本（无需主机安装 Node.js）
#
# 用途：nginx 容器挂载的是宿主机 frontend/dist 目录，因此新服务器首次部署时
#       必须先构建产物，否则页面会白屏。
# 依赖：Docker（会自动使用 node:20-alpine 镜像，容器内安装依赖并打包）
#
# 用法：bash scripts/build_frontend.sh
# 环境变量：NODE_IMAGE（默认 node:20-alpine）、NPM_REGISTRY（默认 npmmirror）
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_DIR/frontend"

NODE_IMAGE="${NODE_IMAGE:-node:20-alpine}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

if [ ! -f "$FRONTEND_DIR/package.json" ]; then
  echo "❌ 未找到 frontend/package.json，请确认目录结构"
  exit 1
fi

echo "🎨 开始构建前端产物..."
echo "   镜像: $NODE_IMAGE"
echo "   源:   $NPM_REGISTRY"
echo "   目录: $FRONTEND_DIR"

cd "$FRONTEND_DIR"

if command -v npm >/dev/null 2>&1; then
  npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
  npm run build
elif command -v docker >/dev/null 2>&1; then
  docker run --rm --memory=1400m \
    -v "$FRONTEND_DIR":/app -w /app \
    "$NODE_IMAGE" \
    sh -c "npm ci --registry=$NPM_REGISTRY --no-audit --no-fund && npm run build"
else
  echo "❌ 主机既无 npm 也无 docker，无法构建前端产物"
  exit 1
fi

if [ -f "$FRONTEND_DIR/dist/index.html" ]; then
  echo "✅ 前端构建完成：$FRONTEND_DIR/dist"
else
  echo "❌ 构建结束但未生成 dist/index.html"
  exit 1
fi
