#!/usr/bin/env bash
# @intent Verify reverse-proxy locally: e2e-build generates literal hostnames (host|upstream|ws); no substitution.
# Run from repo root: bash components/infra-docker/scripts/test-reverse-proxy-local.sh
# Requires api.localhost (and used hosts) in /etc/hosts or equivalent.
set -euo pipefail
. "$(dirname "$0")/config/resolve-repo-root.sh"
REPO_DIR="${REPO_DIR:-$REPO_ROOT}"
ROUTES_FILE="$REPO_DIR/components/infra-docker/generated/reverse-proxy-routes.txt"

echo "[test-reverse-proxy] REPO_DIR=$REPO_DIR"

# Generate routes with literal hostnames (same as EC2: e2e-build runs with THONNAS_ENV + THONNAS_ROOT_DOMAIN)
export THONNAS_ENV="${THONNAS_ENV:-development}"
export THONNAS_ROOT_DOMAIN="${THONNAS_ROOT_DOMAIN:-localhost}"
echo "[test-reverse-proxy] Running e2e-build (THONNAS_ENV=$THONNAS_ENV THONNAS_ROOT_DOMAIN=$THONNAS_ROOT_DOMAIN)..."
(cd "$COMPONENT_ROOT" && export THONNAS_PROJECT_ROOT="$REPO_ROOT" && npm run e2e-build 2>&1) || { echo "[test-reverse-proxy] e2e-build failed"; exit 1; }

if [ ! -f "$ROUTES_FILE" ]; then
  echo "[test-reverse-proxy] Routes file not found: $ROUTES_FILE"
  exit 1
fi
echo "[test-reverse-proxy] Routes (host|upstream|websocket):"
cat "$ROUTES_FILE"

# .env.thonnas for docker compose (optional; reverse-proxy uses literal hosts from routes file)
echo "[test-reverse-proxy] Writing .env.thonnas for compose..."
cat <<'ENVEOF' > "$REPO_DIR/.env.thonnas"
THONNAS_ENV=development
WEB_ANGULAR_PUBLIC_ORIGIN=https://web.localhost
API_GO_HOST=api-go.localhost
API_GO_EXTERNAL_HOST=api-go.localhost
API_NEST_HOST=api.localhost
API_NEST_EXTERNAL_HOST=api.localhost
QUEUE_MQTT_HOST=localhost
QUEUE_MQTT_EXTERNAL_HOST=localhost
WEB_ANGULAR_HOST=web.localhost
WEB_ANGULAR_EXTERNAL_HOST=web.localhost
WEB_REACT_DOCUSAURUS_HOST=localhost
WEB_REACT_DOCUSAURUS_EXTERNAL_HOST=localhost
ENVEOF

echo "[test-reverse-proxy] Creating thonnas-network..."
docker network create thonnas-network 2>/dev/null || true

echo "[test-reverse-proxy] Starting reverse-proxy and api-nest (and dependencies) via compose..."
cd "$COMPONENT_ROOT"
docker compose -f docker-compose.yml -p thonnas-monorepo --env-file "$REPO_DIR/.env.thonnas" up -d infra-docker-reverse-proxy api-nest 2>&1 || {
  echo "[test-reverse-proxy] If services failed (e.g. missing deps), try: docker compose -f docker-compose.yml -p thonnas-monorepo --env-file $REPO_DIR/.env.thonnas up -d"
  exit 1
}

echo "[test-reverse-proxy] Waiting for nginx and api-nest..."
sleep 5

# Test: Host header api.localhost should be proxied to api-nest
echo "[test-reverse-proxy] Curl http://localhost:80/ with Host: api.localhost..."
code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:80/ -H 'Host: api.localhost' 2>/dev/null)" || code="000"
echo "[test-reverse-proxy] HTTP code: $code"
if [ "$code" = "000" ]; then
  echo "[test-reverse-proxy] Connection failed (reverse-proxy or api-nest not ready?)"
  docker ps -a --format "table {{.Names}}\t{{.Status}}" | head -10
  exit 1
fi
if [ "$code" = "502" ]; then
  echo "[test-reverse-proxy] 502 = route not configured or upstream down. Check routes and api-nest."
  exit 1
fi
echo "[test-reverse-proxy] OK: reverse-proxy forwarded Host: api.localhost to api-nest (code $code)."

