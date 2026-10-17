#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
file="backups/station-$(date -u +%Y%m%dT%H%M%SZ).dump"
temp="${file}.partial"
trap 'rm -f "$temp"' EXIT
docker compose --env-file "${DEPLOY_ENV_FILE:-.env.deploy}" -f docker-compose.deploy.yml exec -T postgres pg_dump -U station -d station -Fc > "$temp"
mv "$temp" "$file"
printf '%s\n' "$file"
