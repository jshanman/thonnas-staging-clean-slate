#!/usr/bin/env bash
# @intent Run e2e-build and generate-endpoints. Prefer host node/npm; fall back to devtools container when unavailable (e.g. CI without node).
set -e
. "$(dirname "$0")/config/resolve-repo-root.sh"

# @intent Use repo root from script location when not set by CLI, so paths and compose resolve under project root not worktree cwd
if [ -z "${THONNAS_PROJECT_ROOT:-}" ]; then
  _SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  _COMPONENT_ROOT="$(cd "$_SCRIPT_DIR/.." && pwd)"
  REPO_ROOT="$(cd "$_COMPONENT_ROOT/../.." && pwd)"
  COMPONENT_ROOT="$REPO_ROOT/components/infra-docker"
fi

CONTAINER="devtools-node"
COMPONENT_DIR="/workspace/components/infra-docker"
COMPONENT_DIR_HOST="$COMPONENT_ROOT"

# @intent Prefer host node/npm so EC2 and other environments without devtools can run e2e-build and generate-endpoints directly
NODE_CMD=$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null)
NPM_CMD=$(command -v npm 2>/dev/null)

if [ -n "$NODE_CMD" ] && [ -n "$NPM_CMD" ]; then
  echo "Using host node/npm for e2e-build and generate-endpoints"
  # @intent Prepend component and repo node_modules/.bin so tsx is found without relying on npx (EC2 minimal install)
  export PATH="$COMPONENT_DIR_HOST/node_modules/.bin:$REPO_ROOT/node_modules/.bin:$PATH"
  export THONNAS_PROJECT_ROOT="$REPO_ROOT"
  (cd "$COMPONENT_DIR_HOST" && (npm ci 2>/dev/null || npm install) && npm run e2e-build && npm run generate:endpoints)
  exit 0
fi

# @intent Fallback: run inside devtools-node container (requires docker; node required to bootstrap devtools compose file)
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-thonnas}"
export COMPOSE_PROJECT_NAME

GENERATED_DEVTOLS="$COMPONENT_DIR_HOST/generated/docker-compose.devtools.generated.yml"
if [ ! -f "$GENERATED_DEVTOLS" ]; then
  echo "ERROR: docker-compose.devtools.generated.yml missing. Run with node/npm available to generate it, or commit it." >&2
  exit 1
fi
if ! docker ps -q -f "name=^${CONTAINER}$" | grep -q .; then
  docker network create thonnas-network 2>/dev/null || true
  echo "Starting devtools container..."
  (cd "$COMPONENT_DIR_HOST" && docker compose -f docker-compose.devtools.yml up -d --build)
  echo "Waiting for container to be ready..."
  for i in $(seq 1 30); do
    if docker ps -q -f "name=^${CONTAINER}$" | grep -q .; then
      sleep 2
      break
    fi
    sleep 1
  done
  if ! docker ps -q -f "name=^${CONTAINER}$" | grep -q .; then
    echo "ERROR: Failed to start container ${CONTAINER}." >&2
    exit 1
  fi
fi
# Container mounts project at /workspace; project root inside container is /workspace
docker exec -e THONNAS_PROJECT_ROOT=/workspace "$CONTAINER" sh -c "cd ${COMPONENT_DIR} && (npm ci 2>/dev/null || npm install) && npm run e2e-build && npm run generate:endpoints"

