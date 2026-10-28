#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
umask 077
task_database=${BACKUP_DATABASE:-uni_memory}
[[ $task_database == uni_memory || $task_database == uni_memory_test ]]
task_project=${COMPOSE_PROJECT_NAME:-uni-memory}
[[ $task_project =~ ^[a-z0-9][a-z0-9_-]*$ ]]
task_root=".backups/$task_project"
mkdir -p -- "$task_root"
task_root=$(realpath -- "$task_root")
task_allowed=$(realpath -- .backups)
[[ $task_root == "$task_allowed/"* ]]
task_backup="$task_root/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -- "$task_backup"
trap 'rm -f -- "$task_backup/database.dump.partial"' EXIT
docker compose exec -T postgres pg_dump -U uni_memory -d "$task_database" -Fc > "$task_backup/database.dump.partial"
mv -- "$task_backup/database.dump.partial" "$task_backup/database.dump"
cp -- .env "$task_backup/config.env"
cp -a -- .secrets "$task_backup/secrets"
find "$task_root" -mindepth 1 -maxdepth 1 -type d -name '*T*Z-*' -mtime +14 -exec rm -rf -- {} +
printf '备份完成：%s（含私密配置，保留 14 天）\n' "$task_backup"
