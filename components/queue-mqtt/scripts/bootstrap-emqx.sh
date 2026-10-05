#!/usr/bin/env bash
# @intent Install+start EMQX and join it to this fleet's static cluster on infra.compute.fleet.mqtt
# hosts. MqttFleetStack cannot bake peer IPs into a node's own userdata (two instances referencing
# each other's PrivateIp from within their own resource properties is a genuine CloudFormation
# dependency cycle, not just a synth quirk) -- instead every node in the fleet shares a
# thonnas.mqtt.fleetId tag, and this script discovers its siblings at boot via DescribeInstances,
# the same self-discovery pattern many EC2-native clustered services use. Idempotent: re-running
# after `thonnas infra apply` replaces an instance (or a manual release re-run) only reinstalls
# the binary if the pinned version is missing; the cluster/auth config and service are always
# refreshed, since the peer set or the Secrets Manager password may have changed.
set -euxo pipefail

SECRET_ARN="${THONNAS_MQTT_FLEET_SECRET_ARN:-}"
VOLUME_PATH="${THONNAS_MQTT_FLEET_VOLUME_PATH:-/var/lib/mqtt-data}"
FLEET_ID="${THONNAS_MQTT_FLEET_ID:-}"
EXPECTED_NODE_COUNT="${THONNAS_MQTT_FLEET_EXPECTED_NODE_COUNT:-1}"
# @intent Pin to a known-good el/amzn2023 build (never curl|sh a "latest" alias)
EMQX_VERSION="${THONNAS_MQTT_EMQX_VERSION:-5.8.0}"
INSTALL_DIR="/opt/emqx"

if [ -z "$SECRET_ARN" ]; then
  echo "THONNAS_MQTT_FLEET_SECRET_ARN is required" >&2
  exit 1
fi
if [ -z "$FLEET_ID" ]; then
  echo "THONNAS_MQTT_FLEET_ID is required" >&2
  exit 1
fi

mkdir -p "$VOLUME_PATH/data"

# @intent Resolve region + own private IP via IMDSv2 (token required; a bare v1 curl gets a
# silent empty-body 401 on accounts that default new instances to token-required)
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -sH "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
SELF_IP=$(curl -sH "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

# @intent Idempotent first-boot: download the pinned self-contained tarball (bundles its own
# Erlang runtime; no system package manager / repo compatibility to manage) only if missing
if ! "$INSTALL_DIR/bin/emqx" -v 2>/dev/null | grep -q "$EMQX_VERSION"; then
  WORK="$(mktemp -d)"
  cd "$WORK"
  curl -fsSLO "https://packages.emqx.io/emqx-ce/v${EMQX_VERSION}/emqx-${EMQX_VERSION}-amzn2023-amd64.tar.gz"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "emqx-${EMQX_VERSION}-amzn2023-amd64.tar.gz" -C "$INSTALL_DIR"
  cd /
  rm -rf "$WORK"
fi

# @intent Discover live siblings by shared fleet tag -- retry since a just-launched peer's tags
# (set via RunInstances TagSpecifications, applied atomically, unlike CloudFormation's own lagging
# stack-name/logical-id bookkeeping tags) can still take a moment to appear in DescribeInstances.
PEER_IPS=""
for _ in $(seq 1 30); do
  PEER_IPS=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:thonnas.mqtt.fleetId,Values=${FLEET_ID}" "Name=instance-state-name,Values=running,pending" \
    --query "Reservations[].Instances[].PrivateIpAddress" --output text 2>/dev/null || true)
  COUNT=$(echo "$PEER_IPS" | tr '\t' '\n' | grep -c . || true)
  if [ "$COUNT" -ge "$EXPECTED_NODE_COUNT" ]; then
    break
  fi
  sleep 5
done
if [ -z "$PEER_IPS" ]; then
  # @intent Single-node fleet (or discovery genuinely found nothing) -- seed with just ourselves
  PEER_IPS="$SELF_IP"
fi

SEEDS_JSON=$(printf '%s\n' "$PEER_IPS" | tr '\t' '\n' | grep . | sort -u | awk '{printf "%s\"emqx@%s\"", sep, $0; sep=","}')

# @intent Node identity + cluster membership vary per node/run -- env var overrides (EMQX's
# documented alternative to editing etc/emqx.conf's HOCON directly) avoid fragile per-boot file
# mutation for values only known at runtime.
cat >/etc/emqx-thonnas.env <<EOF
EMQX_NODE__NAME=emqx@${SELF_IP}
EMQX_NODE__DATA_DIR=${VOLUME_PATH}/data
EMQX_CLUSTER__DISCOVERY_STRATEGY=static
EMQX_CLUSTER__STATIC__SEEDS=[${SEEDS_JSON}]
EOF

# @intent Auth config is identical on every node (static, not per-boot) -- append once, since the
# shipped etc/emqx.conf has no authentication block by default. bootstrap_type=plain means EMQX
# hashes the CSV's plaintext password itself on load using password_hash_algorithm below.
if ! grep -q "^authentication" "$INSTALL_DIR/etc/emqx.conf" 2>/dev/null; then
  cat >>"$INSTALL_DIR/etc/emqx.conf" <<'EOF'

authentication = [
  {
    backend = "built_in_database"
    mechanism = "password_based"
    password_hash_algorithm { name = sha256, salt_position = suffix }
    user_id_type = "username"
    bootstrap_file = "${EMQX_ETC_DIR}/auth-built-in-db-bootstrap.csv"
    bootstrap_type = "plain"
  }
]
EOF
fi

# @intent set +x around the only block holding plaintext passwords -- this script inherits
# `set -x` from its shebang, which would otherwise echo them verbatim into SSM/CloudTrail/CloudWatch
# (the exact leak fixed in dba-clickhouse's bootstrap-clickhouse.sh; applying the same guard here
# from the start rather than shipping the same bug twice).
set +x
PASSWORD=$(
  aws secretsmanager get-secret-value \
    --secret-id "$SECRET_ARN" \
    --region "$REGION" \
    --query SecretString \
    --output text \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])'
)
# @intent The browser-exposed frontend credential is a separate, user-provided config-thonnas
# secret (plain string, not the fleet secret's {username,password} JSON), not a CloudFormation
# output -- looked up here by the standard {env}/queue-mqtt/{NAME} naming convention rather than
# threaded through release-fleet.sh (which is shared across every fleet family and has no business
# knowing queue-mqtt's own secret names). Optional: `thonnas config setup` may not have run yet,
# in which case the web-frontend user is simply not created and that connection fails loudly
# instead of silently allowing an unauthenticated frontend identity.
FRONTEND_SECRET_ID="${THONNAS_ENV:-staging}/queue-mqtt/QUEUE_MQTT_FRONTEND_PASSWORD"
FRONTEND_PASSWORD=$(
  aws secretsmanager get-secret-value \
    --secret-id "$FRONTEND_SECRET_ID" \
    --region "$REGION" \
    --query SecretString \
    --output text 2>/dev/null || true
)
{
  echo "user_id,password,is_superuser"
  echo "thonnas,${PASSWORD},false"
  if [ -n "$FRONTEND_PASSWORD" ]; then
    echo "web-frontend,${FRONTEND_PASSWORD},false"
  fi
} >"$INSTALL_DIR/etc/auth-built-in-db-bootstrap.csv"
unset PASSWORD FRONTEND_PASSWORD
set -x
chmod 600 "$INSTALL_DIR/etc/auth-built-in-db-bootstrap.csv"

# @intent Scoped ACL (EMQX's shipped etc/acl.conf defaults to file-based authorization already --
# no separate `authorization` block needed): the web-exposed frontend identity may only announce
# its own presence and read the aggregate count, never anything else -- so a leaked/inspected
# browser password can't be used to snoop other topics or act as the backend. thonnas (never
# shipped to a browser) keeps full access. Explicit trailing deny-all regardless of EMQX's
# built-in no_match default. Rewritten every boot, same as the auth CSV above.
cat >"$INSTALL_DIR/etc/acl.conf" <<'EOF'
{allow, {username, "web-frontend"}, subscribe, ["users/count"]}.
{allow, {username, "web-frontend"}, publish, ["status/user/web/${clientid}"]}.
{allow, {username, "thonnas"}, all, ["#"]}.
{deny, all}.
EOF

cat >/etc/systemd/system/thonnas-emqx.service <<EOF
[Unit]
Description=Thonnas EMQX MQTT broker (fleet ${FLEET_ID})
After=network.target

[Service]
Type=simple
# @intent bin/emqx's own LD_LIBRARY_PATH setup (meant to prepend its bundled dynlibs/ dir, which
# ships libatomic/libcrypto/libtinfo precisely so the AMI doesn't need them preinstalled) does not
# reliably take effect under systemd's minimal environment -- confirmed by reproducing the crash
# (quicer_nif failing to dlopen libatomic.so.1, even though the system package AND the bundled
# copy both exist on disk) and fixing it by setting this explicitly. Without it EMQX crash-loops
# on every boot.
Environment=LD_LIBRARY_PATH=${INSTALL_DIR}/dynlibs
EnvironmentFile=/etc/emqx-thonnas.env
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/bin/emqx foreground
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable thonnas-emqx
systemctl restart thonnas-emqx

READY=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:18083/api/v5/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "EMQX did not become ready on :18083" >&2
  journalctl -u thonnas-emqx --no-pager -n 80 || true
  exit 1
fi

echo "queue-mqtt bootstrap complete (version=${EMQX_VERSION} node=emqx@${SELF_IP} seeds=[${SEEDS_JSON}])"

