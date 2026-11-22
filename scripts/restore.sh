#!/usr/bin/env bash
# ==============================================================================
# 回档脚本：把 Cloudflare R2 上的某一天备份还原回数据库
#
# 用法:
#   bash scripts/restore.sh --list                      # 列出云端所有备份
#   bash scripts/restore.sh 2026-10-30                  # 回档到该日期最新的一份（生产库）
#   bash scripts/restore.sh 2026-10-30 --db test_db     # 演练：还原到临时库，不动生产
#   bash scripts/restore.sh --image /uploads/2026/10/x.webp   # 从回收站找回单张图片
#
# 安全设计:
#   - 覆盖生产库之前，会先把「当前状态」备份到 backups/pre-restore/，回错了还能退回去
#   - 恢复前自动停止 backend，避免边还原边写入
#   - 恢复后做一次健康检查
# ==============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

DB_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2)"; DB_USER="${DB_USER:-app_user}"
DB_NAME="$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2)"; DB_NAME="${DB_NAME:-community_db}"
MEDIA_BUCKET="$(grep -E '^S3_BUCKET=' .env | head -1 | cut -d= -f2)"; MEDIA_BUCKET="${MEDIA_BUCKET:-community}"

r2() { docker compose exec -T backend python /app/ops_scripts/r2.py "$@"; }
psqlc() { docker compose exec -T db psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -q -c "$1"; }

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

[ $# -ge 1 ] || usage

# ---------- 列表 ----------
if [ "$1" = "--list" ]; then
  LIST="$(r2 list backups/db/ | sort)"
  echo "云端可用备份（对象名 / 字节 / 上传时间）："
  echo "$LIST"
  echo
  LATEST_DATE="$(echo "$LIST" | tail -1 | sed -n 's|.*db_\([0-9-]\{10\}\)_.*|\1|p')"
  if [ -n "$LATEST_DATE" ]; then
    echo "回档到该日期最新一份： bash scripts/restore.sh $LATEST_DATE"
  fi
  exit 0
fi

# ---------- 单张图片找回 ----------
if [ "$1" = "--image" ]; then
  REL="${2:-}"
  [ -n "$REL" ] || { echo "缺少图片路径，例如 --image /uploads/2026/10/abc.webp"; exit 1; }
  KEY="$(echo "$REL" | sed 's|^/||')"
  echo "从回收站恢复: trash/$KEY  ->  $KEY"
  docker compose exec -T backend python /app/ops_scripts/r2.py --bucket "$MEDIA_BUCKET" copy "trash/$KEY" "$KEY"
  echo "已恢复。若本地文件也被删过，访问该 URL 会自动从对象存储回源取回。"
  exit 0
fi

# ---------- 数据库回档 ----------
DATE="$1"; shift
TARGET_DB="$DB_NAME"
while [ $# -gt 0 ]; do
  case "$1" in
    --db) TARGET_DB="$2"; shift 2 ;;
    *) usage ;;
  esac
done

KEY="$(r2 list backups/db/ | awk -v d="$DATE" -F'\t' '$1 ~ ("db_" d) {print $1}' | sort | tail -1)"
if [ -z "$KEY" ]; then
  echo "未找到 $DATE 的备份。可用备份如下："
  r2 list backups/db/ | sort
  exit 1
fi

echo "选中备份: $KEY"
echo "目标数据库: $TARGET_DB"
echo

# 1) 覆盖前先把当前状态存到云端，避免回错时间点无法反悔
if [ "$TARGET_DB" = "$DB_NAME" ]; then
  PRE="backups/pre-restore/pre_$(date '+%Y-%m-%d_%H%M%S').sql.gz"
  echo "[1/5] 备份当前生产库 -> $PRE"
  docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --no-owner --no-privileges --clean --if-exists \
    | gzip -9 | r2 put "$PRE"

  echo "[2/5] 停止后端，避免回档期间写入"
  docker compose stop backend
else
  echo "[1/5] 演练模式（目标库 $TARGET_DB），不触碰生产库"
  echo "[2/5] 跳过停服"
fi

# 2) 重建目标库
echo "[3/5] 重建数据库 $TARGET_DB"
psqlc "DROP DATABASE IF EXISTS \"$TARGET_DB\" WITH (FORCE);"
psqlc "CREATE DATABASE \"$TARGET_DB\" OWNER \"$DB_USER\";"

# 3) 流式还原：云端对象 -> gunzip -> psql，不落本地磁盘
echo "[4/5] 流式还原数据"
r2 get "$KEY" | gunzip | docker compose exec -T db psql -U "$DB_USER" -d "$TARGET_DB" -v ON_ERROR_STOP=1 -q

# 4) 起服务并校验
if [ "$TARGET_DB" = "$DB_NAME" ]; then
  echo "[5/5] 启动后端并等待健康检查"
  docker compose start backend >/dev/null
  for i in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/healthz || true)"
    [ "$code" = "200" ] && break
    sleep 3
  done
  echo "健康检查: HTTP $code"
else
  echo "[5/5] 演练库已还原完成（未启动后端）"
fi

echo
echo "=== 数据概览 ($TARGET_DB) ==="
docker compose exec -T db psql -U "$DB_USER" -d "$TARGET_DB" -t -c \
  "select '用户数: '||(select count(*) from users)||'  帖子数: '||(select count(*) from posts)||'  最新帖子: '||coalesce((select max(created_at)::text from posts),'-');" 2>/dev/null \
  || echo "（统计查询失败，不影响还原结果）"

echo
echo "回档完成 ✅"
[ "$TARGET_DB" = "$DB_NAME" ] && echo "如需撤销本次回档，可用备份: $PRE"
[ "$TARGET_DB" != "$DB_NAME" ] && echo "演练库清理: docker compose exec -T db psql -U $DB_USER -d postgres -c 'DROP DATABASE \"$TARGET_DB\";'"
