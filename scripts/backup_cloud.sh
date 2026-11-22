#!/usr/bin/env bash
# ==============================================================================
# 全量上云备份：PostgreSQL + 配置快照 → Cloudflare R2（全程流式，不落本地磁盘）
#
# ⚠️ 已停用：对象存储已关闭（S3_ENABLED=0），当前由 scripts/backup_local.sh
#    每天全量备份到 /data（保留 30 天）。等新对象存储配好、启用 S3_ENABLED 后
#    再考虑恢复本脚本的 cron 调度。
#
# 用法:  bash scripts/backup_cloud.sh
# 建议:  crontab -e 加入（每天 03:30）
#        30 3 * * * scripts/backup_cloud.sh >> ./backups/cron.log 2>&1
#
# 依赖: backend 容器内已挂载 ./scripts → /app/ops_scripts（compose 已配置）
# 说明: 数据库 dump 直接管道进 R2，服务器磁盘不留任何备份文件；
#       保留 30 天，由脚本自身按对象时间清理（无需在控制台配生命周期规则）。
# ==============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="./backups"
LOG="$LOG_DIR/backup.log"
mkdir -p "$LOG_DIR"

# 同一时刻只允许一个备份任务，避免重叠
exec 9>"$LOG_DIR/.backup.lock"
if ! flock -n 9; then
  echo "[$(date '+%F %T')] 已有备份任务在运行，跳过本次" | tee -a "$LOG"
  exit 0
fi

DATE="$(date '+%Y-%m-%d_%H%M%S')"
DB_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2)"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2)"
DB_USER="${DB_USER:-app_user}"
DB_NAME="${DB_NAME:-community_db}"

r2() { docker compose exec -T backend python /app/ops_scripts/r2.py "$@"; }

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "===== 备份开始 (db=$DB_NAME) ====="

# 1) 数据库逻辑备份 —— 直接流式上传，不落盘
DUMP_KEY="backups/db/db_${DATE}.sql.gz"
docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 \
  | r2 put "$DUMP_KEY"
log "数据库已上传: $DUMP_KEY"

# 2) 配置快照（compose / nginx / .env / 脚本），私有桶内保存，便于整机重建
CFG_KEY="backups/config/config_${DATE}.tar.gz"
tar czf - docker-compose.yml .env nginx/nginx.conf nginx/security_headers.conf scripts 2>/dev/null \
  | r2 put "$CFG_KEY"
log "配置快照已上传: $CFG_KEY"

# 3) 保留策略：备份与回收站均保留 30 天
r2 prune --prefix backups/ --days 30
r2 prune --prefix trash/ --days 30

log "===== 备份完成 ====="
