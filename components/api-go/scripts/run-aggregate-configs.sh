#!/usr/bin/env bash
# @intent Run aggregate-configs with env-layer generator in one package main
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

go run scripts/aggregate-configs.go scripts/env-layer-generator.go "$@"

