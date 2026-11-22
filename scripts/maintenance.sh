#!/usr/bin/env bash
# ============================================================
# 站点维护模式开关（纯静态页，不依赖后端 / 数据库）
#
#   ./scripts/maintenance.sh on               # 开启维护（默认「维护中」页）
#   ./scripts/maintenance.sh on notice        # 开启维护，展示「临时访问说明」页
#   ./scripts/maintenance.sh off              # 关闭维护，恢复正常站点
#   ./scripts/maintenance.sh status           # 查看当前状态
#
# 原理：nginx 里对每个请求判断 /etc/nginx/maintenance/on 是否存在，
#       存在即返回 503 并渲染维护页。文件增删即时生效，不需要 reload。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/nginx/maintenance"
FLAG="$DIR/on"
PAGE="$DIR/maintenance.html"

usage() {
  cat <<'EOF'
用法：
  ./scripts/maintenance.sh on [maintenance|notice]   开启维护模式
  ./scripts/maintenance.sh off                       关闭维护模式
  ./scripts/maintenance.sh status                    查看状态

可用页面（nginx/maintenance/pages/）：
  maintenance  站点维护中（默认）
  notice       临时访问说明（域名/DNS 切换期间）
EOF
}

case "${1:-status}" in
  on)
    mode="${2:-maintenance}"
    if [[ ! -f "$DIR/pages/$mode.html" ]]; then
      echo "✗ 页面不存在：nginx/maintenance/pages/$mode.html" >&2
      usage
      exit 1
    fi
    ln -sfn "pages/$mode.html" "$PAGE"
    touch "$FLAG"
    echo "✓ 维护模式已开启，当前展示：$mode"
    echo "  立即生效（无需 reload nginx）；关闭：./scripts/maintenance.sh off"
    ;;
  off)
    rm -f "$FLAG"
    echo "✓ 维护模式已关闭，站点恢复正常"
    ;;
  status)
    if [[ -f "$FLAG" ]]; then
      echo "维护模式：开启（页面：$(readlink "$PAGE" 2>/dev/null || echo "$PAGE")）"
    else
      echo "维护模式：关闭"
    fi
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
