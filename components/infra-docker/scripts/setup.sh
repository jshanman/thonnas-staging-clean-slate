#!/usr/bin/env bash
# @intent Install infra-docker deps so infra derivation can run during config setup
set -e
. "$(dirname "$0")/config/resolve-repo-root.sh"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; skipping infra-docker setup" >&2
  exit 0
fi

(cd "$COMPONENT_ROOT" && npm install)

