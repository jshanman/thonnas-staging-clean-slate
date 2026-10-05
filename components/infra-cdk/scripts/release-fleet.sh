#!/usr/bin/env bash
# @intent `thonnas infra apply` only provisions the bare fleet EC2 instance(s) for an
# infra.compute.fleet.* strategy (volume path + secret ARN env vars baked into cloud-init; see
# dba-fleet-stack.ts / mqtt-fleet-stack.ts) -- it does not install/start the actual service when
# extras.bootstrapUrl is empty (the common case today). Unlike compose-host, a fleet instance
# never gets the project's git repo cloned onto it, so there is no "git reset --hard" to pull in
# updated code -- instead this script pushes the component's own
# components/<component>/scripts/<bootstrap-script> (present locally because `thonnas install`
# copies it there) to every running instance in the fleet over SSM RunShellScript and runs it in
# place. Same transport release-beta.sh uses for compose-host, same one-SSM-call-per-instance
# shape, just without the git/docker-compose lifecycle since a fleet host runs exactly one
# persistent process. Idempotent per instance: each bootstrap script only reinstalls when its
# pinned binary/version is missing, so safe to re-run after every `thonnas infra apply` in case an
# instance was replaced, and safe to re-run against a multi-node fleet to refresh config/secrets.
#
# Generalized from a dba-fleet-only version once a second real consumer (infra.compute.fleet.mqtt)
# needed the identical mechanism -- THONNAS_FLEET_STACK_SUFFIX picks which fleet family to target
# ("DbaFleet", "MqttFleet", ...) and also derives the env var prefix each bootstrap script reads
# (CamelCase -> UPPER_SNAKE: "MqttFleet" -> "MQTT_FLEET" -> THONNAS_MQTT_FLEET_SECRET_ARN, etc.).
set -euo pipefail

# @intent On Windows, botocore's own stdout writer crashes on the unicode glyphs aws CLI/SSM
# output contains unless Python is forced into UTF-8 mode; harmless no-op elsewhere.
export PYTHONUTF8=1
# @intent Git Bash's MSYS layer silently rewrites any env var/arg that *looks* like a POSIX path
# (e.g. "/var/lib/clickhouse") into a Windows path ("C:/Program Files/Git/var/lib/clickhouse")
# before handing it to a non-MSYS child process -- corrupts VOLUME_PATH once it crosses into the
# python3 subprocess below. Harmless no-op outside Git Bash on Windows.
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_COMPONENT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
_REPO_ROOT="$(cd "$_COMPONENT_ROOT/../.." && pwd)"

THONNAS_ENV="${THONNAS_ENV:-${1:-}}"
if [ -z "$THONNAS_ENV" ]; then
  echo "[release-fleet] ERROR: THONNAS_ENV not set (pass as env var or first positional arg)" >&2
  exit 1
fi

COMPONENT="${THONNAS_FLEET_COMPONENT:-}"
STACK_SUFFIX="${THONNAS_FLEET_STACK_SUFFIX:-}"
BOOTSTRAP_SCRIPT_NAME="${THONNAS_FLEET_BOOTSTRAP_SCRIPT:-}"
if [ -z "$COMPONENT" ] || [ -z "$STACK_SUFFIX" ] || [ -z "$BOOTSTRAP_SCRIPT_NAME" ]; then
  echo "[release-fleet] ERROR: THONNAS_FLEET_COMPONENT, THONNAS_FLEET_STACK_SUFFIX, and THONNAS_FLEET_BOOTSTRAP_SCRIPT are all required" >&2
  exit 1
fi
# @intent "MqttFleet" -> "MQTT_FLEET" so THONNAS_${ENV_PREFIX}_SECRET_ARN etc. match what each
# stack's CfnOutput naming and each bootstrap script's env var contract already use verbatim.
ENV_PREFIX=$(echo "$STACK_SUFFIX" | sed 's/\([a-z]\)\([A-Z]\)/\1_\2/g' | tr '[:lower:]' '[:upper:]')

AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_ROOT="${THONNAS_PROJECT_ROOT:-$_REPO_ROOT}"
export AWS_REGION

BOOTSTRAP_LOCAL_PATH="$PROJECT_ROOT/components/$COMPONENT/scripts/$BOOTSTRAP_SCRIPT_NAME"
if [ ! -f "$BOOTSTRAP_LOCAL_PATH" ]; then
  echo "[release-fleet] ERROR: bootstrap script not found at $BOOTSTRAP_LOCAL_PATH (expected 'thonnas install' to have copied it there)" >&2
  exit 1
fi

# @intent Stack-prefix computation (buildEnvProfile's stackPrefix) depends on env category in a
# way that isn't safe to re-derive here -- beta/beta-feat include the project name, staging/
# production deliberately don't (single deployment per account, so nothing to disambiguate). Skip
# guessing the prefix entirely: ask CloudFormation directly for whatever stack this env's `infra
# apply` actually created, matching by suffix (every fleet stack is named
# "<prefix><component><suffix>" regardless of what <prefix> turned out to be) and by env.
STACK_NAME=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?ends_with(StackName, '${COMPONENT}${STACK_SUFFIX}')].StackName" --output text \
  | tr '\t' '\n' | grep -i "${THONNAS_ENV}" | head -1 || true)
if [ -z "$STACK_NAME" ]; then
  echo "[release-fleet] ERROR: no CloudFormation stack found matching '*${COMPONENT}${STACK_SUFFIX}' for env '$THONNAS_ENV'" >&2
  exit 1
fi

echo "[release-fleet] env=$THONNAS_ENV component=$COMPONENT suffix=$STACK_SUFFIX stack=$STACK_NAME"

INSTANCE_IDS=$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=$STACK_NAME" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text)
INSTANCE_COUNT=$(echo "$INSTANCE_IDS" | wc -w)
if [ "$INSTANCE_COUNT" -eq 0 ]; then
  echo "[release-fleet] ERROR: no running instances found for stack '$STACK_NAME'" >&2
  exit 1
fi
echo "[release-fleet] resolved $INSTANCE_COUNT instance(s): $INSTANCE_IDS"

SECRET_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='${STACK_SUFFIX}SecretArn'].OutputValue" --output text)
VOLUME_PATH=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='${STACK_SUFFIX}VolumePath'].OutputValue" --output text)
NODE_COUNT=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='${STACK_SUFFIX}NodeCount'].OutputValue" --output text 2>/dev/null || true)
if [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = "None" ]; then
  echo "[release-fleet] ERROR: could not resolve ${STACK_SUFFIX}SecretArn output from stack $STACK_NAME" >&2
  exit 1
fi
if [ -z "$VOLUME_PATH" ] || [ "$VOLUME_PATH" = "None" ]; then
  VOLUME_PATH="/var/lib/${COMPONENT}"
fi
if [ -z "$NODE_COUNT" ] || [ "$NODE_COUNT" = "None" ]; then
  NODE_COUNT="$INSTANCE_COUNT"
fi
echo "[release-fleet] secretArn=$SECRET_ARN volumePath=$VOLUME_PATH nodeCount=$NODE_COUNT"

if command -v cygpath >/dev/null 2>&1; then
  BOOTSTRAP_LOCAL_PATH_NATIVE=$(cygpath -w "$BOOTSTRAP_LOCAL_PATH")
else
  BOOTSTRAP_LOCAL_PATH_NATIVE="$BOOTSTRAP_LOCAL_PATH"
fi

OVERALL_STATUS=0
for INSTANCE_ID in $INSTANCE_IDS; do
  echo "[release-fleet] --- releasing to $INSTANCE_ID ---"

  # @intent Build the SSM params document with python3 (same technique release-beta.sh uses) so
  # the embedded multi-line bootstrap script survives as a single JSON string -- the
  # `commands=...` shorthand for --parameters cannot carry a multi-line script (AWS CLI
  # flattens/mis-escapes it). FLEET_ID is the stack's own name -- every instance in a fleet is
  # tagged with it (see mqtt-fleet-stack.ts) so a bootstrap script can rediscover its siblings on
  # a manual re-run, not just at original cloud-init boot time. Passed unconditionally; a
  # bootstrap script that doesn't need it (bootstrap-clickhouse.sh today) simply ignores it.
  PARAMS_FILE="${TMPDIR:-${TEMP:-/tmp}}/thonnas-release-fleet-params-$$-${INSTANCE_ID}.json"
  trap 'rm -f "$PARAMS_FILE"' EXIT
  # @intent MSYS_NO_PATHCONV (set above, so VOLUME_PATH survives as a literal POSIX path for the
  # *remote* Linux instance) also stops Git Bash converting BOOTSTRAP_LOCAL_PATH into something a
  # native Windows python3.exe can open -- convert that one path explicitly instead.
  SECRET_ARN="$SECRET_ARN" VOLUME_PATH="$VOLUME_PATH" FLEET_ID="$STACK_NAME" NODE_COUNT="$NODE_COUNT" \
  ENV_PREFIX="$ENV_PREFIX" BOOTSTRAP_LOCAL_PATH="$BOOTSTRAP_LOCAL_PATH_NATIVE" THONNAS_ENV="$THONNAS_ENV" \
  python3 - "$PARAMS_FILE" <<'PYEOF'
import json, os, sys

out_path = sys.argv[1]
with open(os.environ["BOOTSTRAP_LOCAL_PATH"], "r") as f:
    script = f.read()

prefix = os.environ["ENV_PREFIX"]
remote = (
    "set -euo pipefail\n"
    f"export THONNAS_{prefix}_SECRET_ARN=" + os.environ["SECRET_ARN"] + "\n"
    f"export THONNAS_{prefix}_VOLUME_PATH=" + os.environ["VOLUME_PATH"] + "\n"
    f"export THONNAS_{prefix}_ID=" + os.environ["FLEET_ID"] + "\n"
    f"export THONNAS_{prefix}_EXPECTED_NODE_COUNT=" + os.environ["NODE_COUNT"] + "\n"
    # @intent Generic pass-through so any fleet bootstrap script can look up its own
    # component-specific secrets (e.g. bootstrap-emqx.sh's queue-mqtt frontend password) by the
    # standard {env}/{component}/{NAME} secret naming convention, without release-fleet.sh itself
    # (shared across every fleet family) needing to know what those secrets are.
    "export THONNAS_ENV=" + os.environ["THONNAS_ENV"] + "\n"
    "cat > /tmp/thonnas-fleet-bootstrap.sh << 'THONNAS_BOOTSTRAP_EOF'\n"
    + script +
    "\nTHONNAS_BOOTSTRAP_EOF\n"
    "chmod +x /tmp/thonnas-fleet-bootstrap.sh\n"
    "/tmp/thonnas-fleet-bootstrap.sh\n"
)
with open(out_path, "w") as f:
    json.dump({"commands": [remote]}, f)
PYEOF

  if command -v cygpath >/dev/null 2>&1; then
    PARAMS_FILE_NATIVE=$(cygpath -w "$PARAMS_FILE")
  else
    PARAMS_FILE_NATIVE="$PARAMS_FILE"
  fi

  CMD_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "thonnas release fleet ($COMPONENT/$THONNAS_ENV/$INSTANCE_ID)" \
    --timeout-seconds 900 \
    --parameters "file://$PARAMS_FILE_NATIVE" \
    --query "Command.CommandId" --output text)

  echo "[release-fleet] SSM command: $CMD_ID (polling, up to 15 min)"
  STATUS="InProgress"
  for i in $(seq 1 90); do
    STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "Status" --output text 2>/dev/null || echo "Pending")
    case "$STATUS" in
      Success|Failed|Cancelled|TimedOut) break ;;
    esac
    sleep 10
  done
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "StandardOutputContent" --output text
  echo "----- stderr ($INSTANCE_ID) -----"
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query "StandardErrorContent" --output text

  echo "[release-fleet] $INSTANCE_ID final status: $STATUS"
  if [ "$STATUS" != "Success" ]; then
    OVERALL_STATUS=1
  fi
done

if [ "$OVERALL_STATUS" != "0" ]; then
  echo "[release-fleet] FAILED (one or more instances did not succeed)"
  exit 1
fi
echo "[release-fleet] all $INSTANCE_COUNT instance(s) released successfully"

