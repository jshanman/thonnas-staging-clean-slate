#!/usr/bin/env bash
# @intent Bootstrap api-go deps only; config generation runs during thonnas build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[api-go setup] go mod download (toolchain + baseline modules for aggregate-go-deps)…"
go mod download

echo "[api-go setup] go run scripts/aggregate-go-deps.go (merge go.mod.fragment into root go.mod)…"
go run scripts/aggregate-go-deps.go

echo "[api-go setup] go mod tidy…"
go mod tidy

echo "[api-go setup] go mod download…"
go mod download

echo "[api-go setup] done."

