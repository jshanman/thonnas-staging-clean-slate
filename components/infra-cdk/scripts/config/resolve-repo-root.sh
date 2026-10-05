# @intent Resolve project root consistent with the Thonnas CLI (walk up from cwd; .thonnas and/or components/).
# Source from scripts/: . "$(dirname "$0")/config/resolve-repo-root.sh"
# Sets: REPO_ROOT, COMPONENT_ROOT, SCRIPT_DIR. Uses THONNAS_PROJECT_ROOT when set (e.g. by thonnas build/run).
# With dev-link, run thonnas from the target repo; do not run from inside the worktree.
set -euo pipefail 2>/dev/null || true

if [ -n "${THONNAS_PROJECT_ROOT:-}" ]; then
  REPO_ROOT="${THONNAS_PROJECT_ROOT}"
  COMPONENT_ROOT="$REPO_ROOT/components/infra-cdk"
  SCRIPT_DIR="$COMPONENT_ROOT/scripts"
else
  # Walk up from cwd (same as CLI): prefer dir with both .thonnas and components/, else .thonnas, else components/
  _d="$(pwd)"
  _candidate=""
  while [ -n "$_d" ] && [ "$_d" != "/" ]; do
    _has_t=0
    _has_c=0
    [ -e "$_d/.thonnas" ] && _has_t=1
    [ -d "$_d/components" ] && _has_c=1
    if [ "$_has_t" = 1 ] && [ "$_has_c" = 1 ]; then
      REPO_ROOT="$_d"
      break
    fi
    if [ "$_has_t" = 1 ] || [ "$_has_c" = 1 ]; then
      [ -z "$_candidate" ] && _candidate="$_d"
    fi
    _d="$(dirname "$_d")"
  done
  if [ -z "${REPO_ROOT:-}" ]; then
    REPO_ROOT="${_candidate:-$(pwd)}"
  fi
  COMPONENT_ROOT="$REPO_ROOT/components/infra-cdk"
  SCRIPT_DIR="$COMPONENT_ROOT/scripts"
fi

# Infra-cdk needs components/ for generate:endpoints; require it
if [ ! -d "$REPO_ROOT/components" ]; then
  echo "ERROR: Project root at $REPO_ROOT has no components/. Run from a Thonnas project root (or set THONNAS_PROJECT_ROOT). With dev-link, run thonnas from the target repo." >&2
  exit 1
fi
export REPO_ROOT COMPONENT_ROOT SCRIPT_DIR



