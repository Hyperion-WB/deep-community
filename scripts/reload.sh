#!/bin/bash
# ==============================================================================
# 零停机极速平滑更新脚本 (Zero-Downtime Reload)
# 作用: 仅增量更新后端与前端，绝不重启 PostgreSQL 和 Redis，杜绝卡顿与服务中断
# ==============================================================================

set -e

echo ">>> [1/3] 拉取最新代码..."
git pull origin main

echo ">>> [2/3] 增量构建后端与前端容器 (数据库与缓存不重启，服务不中断)..."
docker compose build backend nginx

echo ">>> [3/3] 仅更新应用容器，瞬时生效..."
docker compose up -d --no-deps backend nginx

echo ">>> [SUCCESS] 极速平滑更新完成！"
