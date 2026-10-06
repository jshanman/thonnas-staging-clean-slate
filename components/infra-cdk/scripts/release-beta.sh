#!/usr/bin/env bash
# @intent THE canonical "get the beta app running" script — identical whether this is the very
# first run right after `thonnas infra apply` provisioned the compose-host EC2 (which only
# installs docker and clones the repo; see compose-host-stack.ts) or the Nth release afterward.
# No separate bootstrap sequence: components/modules are git-tracked, so `git reset --hard` alone
# brings new ones onto the box; `thonnas lib ci` (not `lib install`) restores the gitignored
# `.thonnas/libs/` tree to exactly what's locked in the already-committed lockfile — deterministic,
# same as `npm ci` vs `npm install` in a deploy pipeline. Dependency *resolution* (deciding which
# version of a new lib/component to add) is an authoring-time action a human runs locally and
# commits; this script only ever restores what was already decided. `thonnas setup` always runs
# too, since updated code may have added a new component with its own setup step. Safe to run
# repeatedly and safe to call from CI: every step is idempotent, and remote command output is
# polled and surfaced so failures are visible to whichever caller (human shell or GitHub Actions)
# invoked this script.
set -euo pipefail

# @intent On Windows, botocore's own stdout writer crashes on the unicode glyphs (checkmarks, etc.)
# aws CLI/SSM output contains unless Python is forced into UTF-8 mode; harmless no-op elsewhere.
export PYTHONUTF8=1

# @intent Despite the "-beta" filename (kept as-is: it's referenced by exact path from multiple
# repos' thonnas-cicd.json release.compose-host steps, and renaming it would mean updating every
# one of them), this script works for any env -- the name predates compose-host deploys existing
# for staging/production. Precedence: --env flag > THONNAS_RELEASE_ENV > beta (unchanged default,
# so every existing CI caller keeps working without modification).
THONNAS_ENV="${THONNAS_RELEASE_ENV:-beta}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env)
      THONNAS_ENV="$2"
      shift 2
      ;;
    --env=*)
      THONNAS_ENV="${1#--env=}"
      shift
      ;;
    *)
      echo "[release-beta] unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

AWS_REGION="${AWS_REGION:-${THONNAS_BETA_REGION:-us-east-1}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_COMPONENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
_REPO_ROOT="$(cd "$_COMPONENT_ROOT/../.." && pwd)"

# @intent Match the branch the compose-host EC2 actually cloned (see resolve-strategies.ts's own
# THONNAS_COMPOSE_GIT_BRANCH resolution, which defaults to "main"), not an independent "master"
# default -- a repo whose default branch is "main" would otherwise fail every release with
# "couldn't find remote ref master". THONNAS_BETA_BRANCH remains a supported explicit override.
_CONFIG_JSON_BRANCH=""
if [ -f "${_REPO_ROOT}/project/config.json" ]; then
  _CONFIG_JSON_BRANCH=$(grep -o '"THONNAS_COMPOSE_GIT_BRANCH"[[:space:]]*:[[:space:]]*"[^"]*"' "${_REPO_ROOT}/project/config.json" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"/\1/' || true)
fi
BRANCH="${THONNAS_BETA_BRANCH:-${THONNAS_COMPOSE_GIT_BRANCH:-${_CONFIG_JSON_BRANCH:-main}}}"
REPO_DIR="${THONNAS_BETA_REPO_DIR:-/opt/thonnas-app}"
COMPOSE_COMPONENT="${THONNAS_BETA_COMPOSE_COMPONENT:-infra-docker}"
export AWS_REGION

if [ -n "${THONNAS_BETA_INSTANCE_ID:-}" ]; then
  INSTANCE_ID="$THONNAS_BETA_INSTANCE_ID"
  echo "[release-beta] using explicit THONNAS_BETA_INSTANCE_ID=$INSTANCE_ID"
else
  # @intent No stored instance id needed: the compose-host instance Name tag is deterministic
  # from project name + env (resolve-compose-host-name.js mirrors buildEnvProfile's stackPrefix
  # computation), so look it up fresh every run. This also means release-beta.sh keeps working
  # unmodified across a `thonnas infra apply` instance replacement (new instance id, same tag) —
  # no manual THONNAS_BETA_INSTANCE_ID/secret update required. Requires `npm run build` in
  # components/infra-cdk to have produced dist/ first (same prerequisite infra:apply already has).
  NAME_TAG=$(node "$SCRIPT_DIR/resolve-compose-host-name.js" --env "$THONNAS_ENV" --component "$COMPOSE_COMPONENT")
  echo "[release-beta] resolving instance by Name tag: $NAME_TAG"
  MATCHES=$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$NAME_TAG" "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].InstanceId" --output text)
  MATCH_COUNT=$(echo "$MATCHES" | wc -w)
  if [ "$MATCH_COUNT" -eq 0 ]; then
    echo "[release-beta] ERROR: no running instance found with Name tag '$NAME_TAG'" >&2
    exit 1
  elif [ "$MATCH_COUNT" -gt 1 ]; then
    echo "[release-beta] ERROR: found $MATCH_COUNT running instances with Name tag '$NAME_TAG' (expected exactly 1): $MATCHES" >&2
    exit 1
  fi
  INSTANCE_ID="$MATCHES"
  echo "[release-beta] resolved instance: $INSTANCE_ID"
fi

echo "[release-beta] instance=$INSTANCE_ID region=$AWS_REGION branch=$BRANCH repo=$REPO_DIR"

# @intent Single remote script so the whole release is one SSM invocation (simpler polling/log
# capture than chaining several send-command calls, and avoids races between steps).
REMOTE_SCRIPT=$(cat <<REMOTE
set -euo pipefail
log() { echo "[release-beta \$(date -u +%H:%M:%SZ)] \$*"; }

log "Step 0/8: ensure thonnas CLI is present"
if ! command -v thonnas >/dev/null 2>&1; then
  log "thonnas CLI not found, installing"
  curl -fsSL "https://thonnas.parfiamlabs.com/install-beta?agree-to-terms=yes&v=latest" | bash
  export PATH="/usr/bin:\$PATH"
fi
log "thonnas \$(thonnas --version)"

cd "${REPO_DIR}"

log "Step 1/8: thonnas stop --env ${THONNAS_ENV}"
thonnas stop --env ${THONNAS_ENV} || log "stop had failures (continuing; containers may not have been running)"

log "Step 2/8: update repo in place (fetch + reset to origin/${BRANCH})"
DIRTY=\$(git status --porcelain)
if [ -n "\$DIRTY" ]; then
  log "WARNING: discarding uncommitted local drift before reset:"
  echo "\$DIRTY"
fi
git fetch origin "${BRANCH}"
git reset --hard "origin/${BRANCH}"
log "Now at \$(git rev-parse --short HEAD): \$(git log -1 --pretty=%s)"

log "Step 3/8: thonnas lib ci --yes (restore .thonnas/libs/ to exactly what's locked; deploy-restore, never touches components/)"
thonnas lib ci --yes

log "Step 4/8: thonnas setup --continue-on-error --env ${THONNAS_ENV} (in case updated code added a component with its own setup step)"
thonnas setup --continue-on-error --env ${THONNAS_ENV} || log "setup had failures (non-fatal)"

log "Step 5/8: thonnas config setup --env ${THONNAS_ENV} --non-interactive --skip-resolve (best-effort; captures any genuinely new secret, needs Secrets Manager write access to actually add one)"
thonnas config setup --env ${THONNAS_ENV} --non-interactive --skip-resolve || log "config setup had failures (non-fatal; a genuinely new secret must be seeded from a machine with Secrets Manager write access)"

log "Step 6/8: thonnas config resolve --env ${THONNAS_ENV} (always, regardless of step 5 outcome, so .env.${THONNAS_ENV} is current)"
thonnas config resolve --env ${THONNAS_ENV} || log "config resolve had failures (non-fatal)"

log "Step 7/8: thonnas build --continue-on-error --env ${THONNAS_ENV}"
thonnas build --continue-on-error --env ${THONNAS_ENV} || log "build had failures (non-fatal)"

log "Step 8/8: thonnas start --env ${THONNAS_ENV}"
docker network create thonnas-network 2>/dev/null || true
# @intent \`docker compose up\` reuses a container already sitting in "created"/"exited" state
# instead of recreating it, even with a fresh image — so a one-shot init container (db-migrate,
# provisioning, etc.) that failed on a previous run stays broken forever until force-recreated.
# Clear any such stragglers from this project before starting so init containers always get a
# genuinely fresh attempt this release. Same project-name resolution as start.beta.sh.
PROJECT_NAME="\${THONNAS_PROJECT_NAME:-}"
if [ -z "\$PROJECT_NAME" ]; then
  PROJECT_NAME=\$(grep -E '"THONNAS_PROJECT_NAME"' project/config.json 2>/dev/null | sed -n 's/.*"THONNAS_PROJECT_NAME"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1) || true
fi
if [ -z "\$PROJECT_NAME" ]; then
  PROJECT_NAME=\$(grep -E '"name"' thonnas-package.json | head -1 | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p') || true
fi
if [ -n "\$PROJECT_NAME" ]; then
  STALE=\$(docker ps -a --filter "label=com.docker.compose.project=\$PROJECT_NAME" --filter "status=created" --filter "status=exited" -q) || true
  if [ -n "\$STALE" ]; then
    log "Removing \$(echo "\$STALE" | wc -l) stale one-shot container(s) before start"
    docker rm -f \$STALE >/dev/null
  fi
else
  log "WARNING: could not determine compose project name; skipping stale-container cleanup"
fi
thonnas start --env ${THONNAS_ENV}

log "Release complete"
REMOTE
)

# @intent The `commands=...` shorthand for --parameters cannot carry a multi-line script (AWS CLI
# flattens/mis-escapes it); build a proper JSON parameters document instead.
PARAMS_FILE="${TMPDIR:-${TEMP:-/tmp}}/thonnas-release-beta-params-$$.json"
trap 'rm -f "$PARAMS_FILE"' EXIT
python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$REMOTE_SCRIPT" > "$PARAMS_FILE"
# @intent aws.exe on Windows doesn't understand Git Bash's /tmp path; use a native path for file://
if command -v cygpath >/dev/null 2>&1; then
  PARAMS_FILE_NATIVE=$(cygpath -w "$PARAMS_FILE")
else
  PARAMS_FILE_NATIVE="$PARAMS_FILE"
fi

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "thonnas release beta" \
  --timeout-seconds 1800 \
  --parameters "file://$PARAMS_FILE_NATIVE" \
  --query "Command.CommandId" --output text)

echo "[release-beta] SSM command: $CMD_ID (polling, up to 30 min)"
STATUS="InProgress"
for i in $(seq 1 180); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "Status" --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
  sleep 10
done
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "StandardOutputContent" --output text
echo "----- stderr -----"
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "StandardErrorContent" --output text

echo "[release-beta] final status: $STATUS"
if [ "$STATUS" != "Success" ]; then
  echo "[release-beta] FAILED"
  exit 1
fi
