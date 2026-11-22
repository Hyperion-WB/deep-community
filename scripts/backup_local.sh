#!/usr/bin/env bash
# ==============================================================================
# 全量本地备份：PostgreSQL + 上传文件 + 配置快照
#
# 规则：
#   - 只写数据盘（默认 ./backups），落到系统盘 / 会直接中止；
#   - 每天一份、全量备份，保留 30 天，超过 30 天自动删除；
#   - 上传文件用 tar 不压缩（webp/gif 本身已压缩，再 gzip 纯耗 CPU 不省空间）；
#   - 配置快照不含 .env（密钥不进入备份包）。
#
# 用法：
#   bash scripts/backup_local.sh            # 立即备份
#   BACKUP_DIR=/data/xxx bash scripts/...   # 覆盖目标目录
#
# cron（每天 03:30）：
#   30 3 * * * scripts/backup_local.sh >> ./backups/cron.log 2>&1
#
# 恢复（先停 backend 避免边还原边写入，再按需执行）：
#   docker compose stop backend
#   gunzip -c ./backups/db_<STAMP>.sql.gz | docker compose exec -T db psql -U app_user -d community_db
#   tar -xf ./backups/uploads_<STAMP>.tar -C .
#   docker compose start backend
# ==============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
UPLOADS_DIR="${UPLOADS_DIR:-./uploads}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date '+%Y%m%d_%H%M%S')"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# ---------- 0) 安全护栏：备份必须落在数据盘 ----------
BACKUP_MNT="$(df -P "$BACKUP_DIR" | awk 'NR==2 {print $6}')"
if [ "$BACKUP_MNT" = "/" ]; then
  log "错误: 备份目录 $BACKUP_DIR 位于系统盘（挂载点 /），已中止。请改到 /data 等数据盘"
  exit 1
fi

# 同一时刻只允许一个备份任务
exec 9>"$BACKUP_DIR/.backup.lock"
if ! flock -n 9; then
  log "已有备份任务在运行，跳过本次"
  exit 0
fi

DB_USER="$(grep -E '^POSTGRES_USER=' .env 2>/dev/null | head -1 | cut -d= -f2)"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env 2>/dev/null | head -1 | cut -d= -f2)"
DB_USER="${DB_USER:-app_user}"
DB_NAME="${DB_NAME:-community_db}"

log "===== 备份开始 (db=$DB_NAME, 保留 ${KEEP_DAYS} 天, 挂载点 $BACKUP_MNT) ====="

# ---------- 1) 数据库 ----------
if ! docker compose ps --status running --services | grep -qx db; then
  log "错误: db 容器未运行，备份中止"
  exit 1
fi

DB_FILE="$BACKUP_DIR/db_$STAMP.sql.gz"
if docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" --no-owner --no-privileges' \
     | gzip -6 > "$DB_FILE"; then
  if [ ! -s "$DB_FILE" ]; then
    log "错误: 数据库备份为空，已删除"
    rm -f "$DB_FILE"
    exit 1
  fi
  log "数据库备份完成: $(basename "$DB_FILE") ($(du -h "$DB_FILE" | cut -f1))"
else
  log "错误: 数据库备份失败"
  rm -f "$DB_FILE"
  exit 1
fi

# ---------- 2) 上传文件（全量，不压缩） ----------
if [ -d "$UPLOADS_DIR" ]; then
  UPLOADS_FILE="$BACKUP_DIR/uploads_$STAMP.tar"
  tar -cf "$UPLOADS_FILE" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"
  log "上传文件备份完成: $(basename "$UPLOADS_FILE") ($(du -h "$UPLOADS_FILE" | cut -f1))"
else
  log "警告: 上传目录不存在 $UPLOADS_DIR，跳过"
fi

# ---------- 3) 配置快照（不含 .env 密钥） ----------
CONFIG_FILE="$BACKUP_DIR/config_$STAMP.tar.gz"
tar -czf "$CONFIG_FILE" \
  docker-compose.yml nginx scripts backend/requirements.txt README.md DEPLOY.md 2>/dev/null || true
log "配置快照完成: $(basename "$CONFIG_FILE")（不含 .env）"

# ---------- 4) 清理超过保留期的备份 ----------
REMOVED="$(find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'db_*.sql.gz' -o -name 'uploads_*.tar' -o -name 'config_*.tar.gz' \) \
  -mtime +"$KEEP_DAYS" -print -delete | wc -l)"
log "已清理 ${KEEP_DAYS} 天前的旧备份: ${REMOVED} 个"

# ---------- 5) 磁盘余量提醒 ----------
AVAIL_KB="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
if [ "${AVAIL_KB:-0}" -lt 5242880 ]; then
  log "警告: 备份分区剩余不足 5GB（当前 $((AVAIL_KB / 1024))MB），请清理或扩容"
fi

log "===== 备份完成 ====="
