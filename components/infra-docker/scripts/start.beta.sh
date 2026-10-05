#!/usr/bin/env bash
# @intent Start beta/EC2 stack: base compose only, PLUS the LocalStack event-bus override
# (infra-localstack + queue-sns-provision) so beta uses the same in-cluster SNS/SQS emulation
# as local dev instead of real AWS resources. Other components' docker-compose.override.yml
# files (dev-only hot-reload bind mounts etc.) stay excluded. Services load env from
# per-component .env.beta (config resolve). THONNAS_ENV=beta set here; *_EXTERNAL_HOST on EC2
# come from user-data sourcing .env.thonnas before calling thonnas start.
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

# So compose resolves env_file: ./.env.${THONNAS_ENV:-development} to each component's .env.beta (written by thonnas config resolve)
export THONNAS_ENV=beta

# Project name: same resolution as start.development.sh
if [ -n "${THONNAS_PROJECT_NAME:-}" ]; then
  PROJECT_NAME="$THONNAS_PROJECT_NAME"
elif [ -f project/config.json ]; then
  PROJECT_NAME=$(grep -E '"THONNAS_PROJECT_NAME"' project/config.json | sed -n 's/.*"THONNAS_PROJECT_NAME"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
if [ -z "${PROJECT_NAME:-}" ]; then
  PROJECT_NAME=$(grep -E '"name"' thonnas-package.json | head -1 | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
: "${PROJECT_NAME:?Could not determine project name from THONNAS_PROJECT_NAME, project/config.json, or thonnas-package.json}"

# @intent Ensure external network exists (compose declares it external; required on EC2 and when npm run up was not used)
docker network create thonnas-network 2>/dev/null || true

# Base compose file, plus infra-localstack/queue-sns overrides only (not the full dev override
# set). Reverse-proxy reads mounted routes file at container start and hostnames from env.
# Build first so build-only services (e.g. dbt-mongo-init, dbt-postgres-init) exist; then pull/up (pull may skip or fail for local images).
# @intent Run compose from REPO_ROOT with explicit -f so include paths resolve under project root
COMPOSE_FILE="$COMPONENT_ROOT/docker-compose.yml"
cd "$REPO_ROOT"

COMPOSE_F_ARGS=(-f "$COMPOSE_FILE")
for extra in components/infra-localstack/docker-compose.override.yml components/queue-sns/docker-compose.override.yml; do
  if [ -f "$REPO_ROOT/$extra" ]; then
    COMPOSE_F_ARGS+=(-f "$REPO_ROOT/$extra")
  fi
done

docker compose "${COMPOSE_F_ARGS[@]}" -p "$PROJECT_NAME" build
# When BUILD_NO_CACHE_SERVICES is set (e.g. deploy sets web-angular), rebuild those without cache so code/config changes are picked up
if [ -n "${BUILD_NO_CACHE_SERVICES:-}" ]; then
  echo "[start.beta] Rebuilding without cache: $BUILD_NO_CACHE_SERVICES"
  docker compose "${COMPOSE_F_ARGS[@]}" -p "$PROJECT_NAME" build --no-cache $BUILD_NO_CACHE_SERVICES
fi
docker compose "${COMPOSE_F_ARGS[@]}" -p "$PROJECT_NAME" pull --ignore-pull-failures 2>/dev/null || true
# @intent Remove containers that are no longer in the compose file (e.g. after renaming reverse-proxy -> infra-docker-reverse-proxy) so ports are freed
docker compose "${COMPOSE_F_ARGS[@]}" -p "$PROJECT_NAME" up -d --remove-orphans

