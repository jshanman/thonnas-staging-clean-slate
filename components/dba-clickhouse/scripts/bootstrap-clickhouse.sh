#!/usr/bin/env bash
# @intent Install+start ClickHouse with colocated Keeper on DbaFleet hosts
set -euxo pipefail

SECRET_ARN="${THONNAS_DBA_FLEET_SECRET_ARN:-}"
VOLUME_PATH="${THONNAS_DBA_FLEET_VOLUME_PATH:-/var/lib/clickhouse}"
# @intent Pin to compose image line (signoz collector migrations break on CH 26+)
CLICKHOUSE_VERSION="${THONNAS_DBA_CLICKHOUSE_VERSION:-25.5.6.14}"

if [ -z "$SECRET_ARN" ]; then
  echo "THONNAS_DBA_FLEET_SECRET_ARN is required" >&2
  exit 1
fi

mkdir -p "$VOLUME_PATH" \
  "$VOLUME_PATH/coordination/log" \
  "$VOLUME_PATH/coordination/snapshots"

# @intent Idempotent first-boot: download pinned packages (never curl|sh master)
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) PKG_ARCH=amd64 ;;
  aarch64|arm64) PKG_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

if ! command -v clickhouse >/dev/null 2>&1 || ! clickhouse --version 2>/dev/null | grep -q "$CLICKHOUSE_VERSION"; then
  WORK="$(mktemp -d)"
  cd "$WORK"
  for PKG in clickhouse-common-static clickhouse-server clickhouse-client; do
    curl -fsSLO "https://packages.clickhouse.com/tgz/stable/${PKG}-${CLICKHOUSE_VERSION}-${PKG_ARCH}.tgz" \
      || curl -fsSLO "https://packages.clickhouse.com/tgz/stable/${PKG}-${CLICKHOUSE_VERSION}.tgz"
    tar -xzf "${PKG}-${CLICKHOUSE_VERSION}-${PKG_ARCH}.tgz" 2>/dev/null \
      || tar -xzf "${PKG}-${CLICKHOUSE_VERSION}.tgz"
    INSTALL_DIR=""
    if [ -d "${PKG}-${CLICKHOUSE_VERSION}" ]; then
      INSTALL_DIR="${PKG}-${CLICKHOUSE_VERSION}"
    elif [ -d "${PKG}-${CLICKHOUSE_VERSION}-${PKG_ARCH}" ]; then
      INSTALL_DIR="${PKG}-${CLICKHOUSE_VERSION}-${PKG_ARCH}"
    fi
    if [ -z "$INSTALL_DIR" ] || [ ! -x "${INSTALL_DIR}/install/doinst.sh" ]; then
      echo "missing install script for $PKG" >&2
      exit 1
    fi
    if [ "$PKG" = "clickhouse-server" ]; then
      "${INSTALL_DIR}/install/doinst.sh" configure
    else
      "${INSTALL_DIR}/install/doinst.sh"
    fi
  done
  cd /
  rm -rf "$WORK"
fi

# @intent ClickHouse runs as clickhouse user — fix root-created volume paths
if id clickhouse >/dev/null 2>&1; then
  chown -R clickhouse:clickhouse "$VOLUME_PATH"
fi

mkdir -p /etc/clickhouse-server/config.d

# @intent Colocate Keeper inside this package — do not publish infra.coord.zookeeper
cat >/etc/clickhouse-server/config.d/keeper.xml <<EOF
<clickhouse>
  <path>${VOLUME_PATH}/</path>
  <zookeeper><node><host>127.0.0.1</host><port>9181</port></node></zookeeper>
  <keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>
    <log_storage_path>${VOLUME_PATH}/coordination/log</log_storage_path>
    <snapshot_storage_path>${VOLUME_PATH}/coordination/snapshots</snapshot_storage_path>
    <raft_configuration><server><id>1</id><hostname>127.0.0.1</hostname><port>9234</port></server></raft_configuration>
  </keeper_server>
</clickhouse>
EOF

cat >/etc/clickhouse-server/config.d/listen.xml <<'EOF'
<clickhouse><listen_host>0.0.0.0</listen_host></clickhouse>
EOF

cat >/etc/clickhouse-server/config.d/cluster.xml <<'EOF'
<clickhouse><remote_servers><cluster><shard><replica><host>127.0.0.1</host><port>9000</port></replica></shard></cluster></remote_servers></clickhouse>
EOF

cat >/etc/clickhouse-server/config.d/macros.xml <<'EOF'
<clickhouse><macros><shard>01</shard><replica>01</replica><cluster>cluster</cluster></macros></clickhouse>
EOF

clickhouse start || systemctl start clickhouse-server || true

# @intent Wait longer for first-boot Keeper+server on cold xs hosts
READY=0
for i in $(seq 1 60); do
  if clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  echo "ClickHouse did not become ready on :9000" >&2
  tail -50 /var/log/clickhouse-server/clickhouse-server.err.log 2>/dev/null || true
  exit 1
fi

# @intent Resolve region via IMDSv2 then create thonnas user from Secrets Manager
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -sH "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

clickhouse-client --query "CREATE DATABASE IF NOT EXISTS default"
# @intent set +x around the only block that ever holds the plaintext password -- `set -x` (on
# since the shebang's -x) would otherwise echo it verbatim into SSM command output/CloudTrail/
# CloudWatch, which is a live credential leak, not just a noisy log.
set +x
PASSWORD=$(
  aws secretsmanager get-secret-value \
    --secret-id "$SECRET_ARN" \
    --region "$REGION" \
    --query SecretString \
    --output text \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])'
)
clickhouse-client --query "CREATE USER IF NOT EXISTS thonnas IDENTIFIED WITH sha256_password BY '${PASSWORD}'"
unset PASSWORD
set -x
clickhouse-client --query "GRANT CURRENT GRANTS ON *.* TO thonnas"

echo "dba-clickhouse bootstrap complete (version=${CLICKHOUSE_VERSION} volume=${VOLUME_PATH})"

