#!/usr/bin/env bash
# @intent thonnas build hook: generate config after modules install, then compile Go
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[api-go build] go run scripts/aggregate-go-deps.go…"
go run scripts/aggregate-go-deps.go
go mod tidy

echo "[api-go build] bash scripts/run-aggregate-configs.sh…"
bash scripts/run-aggregate-configs.sh

echo "[api-go build] go build ./cmd/... ./internal/..."
go build ./cmd/... ./internal/...

echo "[api-go build] done."

