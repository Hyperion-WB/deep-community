#!/bin/bash
# 数据库与关键配置备份：本地 3 天滚动 + 上传 Cloudflare R2 异地容灾
#
# ⚠️ 当前状态：已停用（不再由 cron 调度），脚本保留供手动/正式环境使用。
#    手动执行：bash scripts/backup_r2.sh
#    重新启用：crontab -e 添加
#      30 3 * * * /opt/liaotian/scripts/backup_r2.sh >> /opt/backups/cron.log 2>&1
#    注意：备份包内含 .env（含对象存储/DB/密钥），启用前请改用私有桶或加密。
set -e
cd /opt/liaotian

BACKUP_DIR="${BACKUP_DIR:-/opt/backups}"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "[$DATE] Starting backup..."

# 1. PostgreSQL 逻辑备份
docker exec liaotian-db-1 pg_dump -U app_user community_db | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# 2. 关键配置快照 (compose / nginx / .env / scripts)
tar czf "$BACKUP_DIR/config_$DATE.tar.gz" docker-compose.yml nginx .env scripts 2>/dev/null || true

# 3. 拷入 backend 容器后上传至 R2 异地容灾（容器内无法直接读宿主机路径）
DB_FILE="db_$DATE.sql.gz"
CFG_FILE="config_$DATE.tar.gz"
docker compose cp "$BACKUP_DIR/$DB_FILE" backend:/tmp/"$DB_FILE"
docker compose cp "$BACKUP_DIR/$CFG_FILE" backend:/tmp/"$CFG_FILE"

docker compose exec -T backend python - <<PYEOF
import boto3, os
from botocore.config import Config
s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],
    aws_access_key_id=os.environ["S3_ACCESS_KEY"],
    aws_secret_access_key=os.environ["S3_SECRET_KEY"],
    region_name="auto",
    config=Config(signature_version="s3v4"),
)
for f in ["/tmp/$DB_FILE", "/tmp/$CFG_FILE"]:
    if os.path.exists(f):
        s3.upload_file(f, os.environ["S3_BUCKET"], "backups/" + os.path.basename(f))
        print("uploaded:", os.path.basename(f))
        os.remove(f)
PYEOF

# 4. 本地仅保留 3 天（R2 侧建议在 Cloudflare 控制台配置 backups/ 前缀 30 天生命周期规则）
find "$BACKUP_DIR" -name "*.gz" -mtime +3 -delete

echo "[$DATE] Backup completed." >> "$BACKUP_DIR/backup.log"
