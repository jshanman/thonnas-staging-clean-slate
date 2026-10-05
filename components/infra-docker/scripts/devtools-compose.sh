#!/usr/bin/env bash
# @intent Run devtools compose with -p from THONNAS_PROJECT_NAME or repo root package name
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPONENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPONENT_ROOT/../.." && pwd)"

if [ -n "${THONNAS_PROJECT_NAME:-}" ]; then
  PROJECT_NAME="$THONNAS_PROJECT_NAME"
else
  # @intent Match thonnas run default when CLI omits THONNAS_PROJECT_NAME (e.g. npm run from component)
  PROJECT_NAME="$(
    COMPONENT_ROOT="$COMPONENT_ROOT" node -e "const fs=require('fs'),path=require('path');const root=path.resolve(process.env.COMPONENT_ROOT,'..','..');const p=path.join(root,'thonnas-package.json');process.stdout.write(JSON.parse(fs.readFileSync(p,'utf8')).name);"
  )"
fi

cd "$REPO_ROOT"
exec docker compose -p "$PROJECT_NAME" -f components/infra-docker/docker-compose.devtools.yml "$@"

