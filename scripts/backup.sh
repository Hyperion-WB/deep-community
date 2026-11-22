#!/bin/bash
set -e

BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "[$DATE] Starting automated community platform backup..."

# 1. 导出 PostgreSQL 压缩包
if docker ps -qf "name=db" | grep -q .; then
    docker exec $(docker ps -qf "name=db" | head -n 1) pg_dump -U app_user community_db | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"
    echo "[$DATE] PostgreSQL backup saved to $BACKUP_DIR/db_$DATE.sql.gz"
fi

# 2. 增量压缩图片目录
if [ -d "./uploads" ]; then
    tar -czf "$BACKUP_DIR/uploads_$DATE.tar.gz" -C ./uploads .
    echo "[$DATE] Uploads backup saved to $BACKUP_DIR/uploads_$DATE.tar.gz"
fi

# 3. 清理 7 天前的历史备份
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +7 -delete
find "$BACKUP_DIR" -name "uploads_*.tar.gz" -mtime +7 -delete

echo "[$DATE] Backup Completed Successfully." >> "$BACKUP_DIR/backup.log"
