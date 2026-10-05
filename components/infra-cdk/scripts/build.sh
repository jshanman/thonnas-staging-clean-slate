#!/usr/bin/env bash
set -e
COMPONENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$COMPONENT_DIR"
npm install 2>/dev/null || true
npm run build



