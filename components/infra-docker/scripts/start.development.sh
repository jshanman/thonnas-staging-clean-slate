#!/usr/bin/env bash
# @intent Start development stack: docker compose up with project name from env, project/config.json, or root thonnas-package.json
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

# @intent Ensure generated/ docker compose files exist before compose up
REQUIRED_GENERATED=(
  "$COMPONENT_ROOT/generated/docker-compose.generated.yml"
  "$COMPONENT_ROOT/generated/docker-compose.devtools.generated.yml"
  "$COMPONENT_ROOT/generated/docker-compose.override.generated.yml"
)
for f in "${REQUIRED_GENERATED[@]}"; do
  if [ ! -f "$f" ]; then
    echo "Error: Required generated file not found: $f" >&2
    echo "Run 'thonnas build' (or npm run e2e-build in infra-docker) to generate the Docker compose files, then try again." >&2
    exit 1
  fi
done

# @intent Export unioned LocalStack SERVICES so infra-localstack compose interpolates one list
LOCALSTACK_ENV_FILE="$COMPONENT_ROOT/generated/.env.localstack"
COMPOSE_ENV_ARGS=()
if [ -f "$LOCALSTACK_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$LOCALSTACK_ENV_FILE"
  set +a
  COMPOSE_ENV_ARGS+=(--env-file "components/infra-docker/generated/.env.localstack")
fi

# @intent Ensure external network exists (compose declares it external)
docker network create thonnas-network 2>/dev/null || true

# @intent Force-remove exited/created one-shot containers (e.g. *-init services) before compose
# up. `thonnas start` runs each component's start script in sequence, and several delegate back
# here, so compose up runs more than once per `thonnas start`; without this, compose reuses/
# restarts an already-exited one-shot container instead of recreating it, and re-running an
# install-on-start entrypoint against that stale container filesystem can leave broken state
# (e.g. a corrupted CLI symlink) instead of a clean re-install.
STALE=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "status=created" --filter "status=exited" -q) || true
if [ -n "$STALE" ]; then
  echo "Removing stale one-shot container(s) before start: $STALE"
  docker rm -f $STALE >/dev/null
fi

# @intent Run compose from REPO_ROOT; use paths relative to REPO_ROOT for -f so Git Bash does not pass
# @intent /c/... to docker.exe as C:\c\... (broken open on Windows).
cd "$REPO_ROOT"
docker compose -p "$PROJECT_NAME" \
  "${COMPOSE_ENV_ARGS[@]}" \
  -f components/infra-docker/docker-compose.yml \
  -f components/infra-docker/docker-compose.override.yml \
  up -d

# @intent Start devtools (e.g. devtools-node) so they are available during development
docker compose -p "$PROJECT_NAME" -f components/infra-docker/docker-compose.devtools.yml up -d

