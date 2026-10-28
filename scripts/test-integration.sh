#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
test -f .env || { echo '请先 npm run init'; exit 2; }
docker compose -p uni-memory-test -f compose.yaml -f compose.test.yaml stop app
docker compose -p uni-memory-test -f compose.yaml -f compose.test.yaml up -d --wait postgres qdrant
docker compose -p uni-memory-test -f compose.yaml -f compose.test.yaml build app
docker compose -p uni-memory-test -f compose.yaml -f compose.test.yaml run --rm --no-deps app npm run test:integration
