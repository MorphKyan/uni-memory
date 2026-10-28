#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
if [[ ${1:-} != --replace-current || $# != 2 ]]; then
  echo '用法：bash scripts/restore.sh --replace-current BACKUP_DIRECTORY（覆盖当前数据库和配置）' >&2; exit 2
fi
task_restore=$(realpath -- "$2")
test -f "$task_restore/database.dump"
test -f "$task_restore/config.env"
test -f "$task_restore/secrets/jwks.json"
task_database=${BACKUP_DATABASE:-uni_memory}
[[ $task_database == uni_memory || $task_database == uni_memory_test ]]
# 保留当前数据库密码，避免恢复配置与已初始化 PostgreSQL 实例的密码不一致。
task_current_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)
[[ $task_current_password =~ ^[a-f0-9]{64}$ ]]
docker compose stop app
docker compose exec -T postgres pg_restore -U uni_memory -d "$task_database" --clean --if-exists --exit-on-error --single-transaction < "$task_restore/database.dump"
cp -- "$task_restore/config.env" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$task_current_password/" .env
cp -a -- "$task_restore/secrets/." .secrets/
docker compose up -d --force-recreate qdrant
docker compose run --rm --no-deps app node dist/src/cli.js reset-index --confirm
docker compose up -d --force-recreate app
echo '数据库与配置已恢复，索引已登记重建。旧备份可能恢复曾删除内容，请按删除记录核实。'
