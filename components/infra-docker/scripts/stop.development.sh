#!/usr/bin/env bash
# @intent Stop development stack: docker compose stop (default) or down -v --rmi local with --reset
# Usage: stop.development.sh [--reset]  (--reset runs down -v --rmi local to remove volumes and images)
set -euo pipefail
. "$(dirname "$0")/config/resolve-repo-root.sh"

# @intent Use repo root from script location when not set by CLI, so compose includes resolve under project root not worktree cwd
if [ -z "${THONNAS_PROJECT_ROOT:-}" ]; then
  _SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  _COMPONENT_ROOT="$(cd "$_SCRIPT_DIR/.." && pwd)"
  REPO_ROOT="$(cd "$_COMPONENT_ROOT/../.." && pwd)"
  COMPONENT_ROOT="$REPO_ROOT/components/infra-docker"
fi

cd "$REPO_ROOT"

# Prefer THONNAS_PROJECT_NAME from env (e.g. after sourcing .env) or project/config.json; default to root thonnas-package.json name
if [ -n "${THONNAS_PROJECT_NAME:-}" ]; then
  PROJECT_NAME="$THONNAS_PROJECT_NAME"
elif [ -f project/config.json ]; then
  PROJECT_NAME=$(grep -E '"THONNAS_PROJECT_NAME"' project/config.json | sed -n 's/.*"THONNAS_PROJECT_NAME"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
if [ -z "${PROJECT_NAME:-}" ]; then
  PROJECT_NAME=$(grep -E '"name"' thonnas-package.json | head -1 | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
: "${PROJECT_NAME:?Could not determine project name from THONNAS_PROJECT_NAME, project/config.json, or thonnas-package.json}"

RESET=false
for arg in "$@"; do
  if [ "$arg" = "--reset" ]; then
    RESET=true
    break
  fi
done

# @intent Run compose from REPO_ROOT; use relative -f paths for Windows Git Bash + docker.exe (see start.development.sh).
cd "$REPO_ROOT"
if [ "$RESET" = true ]; then
  docker compose -p "$PROJECT_NAME" -f components/infra-docker/docker-compose.yml down -v --rmi local
else
  docker compose -p "$PROJECT_NAME" -f components/infra-docker/docker-compose.yml stop
fi

