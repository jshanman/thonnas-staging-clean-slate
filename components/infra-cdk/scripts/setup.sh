#!/usr/bin/env bash
# @intent Install infra-cdk deps (tsx etc) so thonnas config resolve can run infra derivation before build
set -e
. "$(dirname "$0")/config/resolve-repo-root.sh"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found; skipping infra-cdk setup" >&2
  exit 0
fi

(cd "$COMPONENT_ROOT" && npm install)



