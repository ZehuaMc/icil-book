#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 2 || ! "$2" =~ ^restore_[a-z0-9_]+$ || ! -f "$1" ]]; then
    echo '用法: bash scripts/restore.sh backups/xxx.dump restore_drill_20261016' >&2
    echo '仅恢复到新建的 restore_ 前缀数据库，避免覆盖运行中的数据。' >&2
    exit 1
fi
compose=(docker compose --env-file "${DEPLOY_ENV_FILE:-.env.deploy}" -f docker-compose.deploy.yml)
"${compose[@]}" exec -T postgres createdb -U station "$2"
"${compose[@]}" exec -T postgres pg_restore -U station -d "$2" --exit-on-error --no-owner < "$1"
echo "已恢复至独立数据库 $2；原数据库不受影响。"
