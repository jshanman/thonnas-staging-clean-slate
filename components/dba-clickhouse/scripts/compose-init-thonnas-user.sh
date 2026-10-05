#!/usr/bin/env bash
# @intent Create local compose `thonnas` user from generated DBA_CLICKHOUSE_PASSWORD
set -euo pipefail

PASSWORD="${SECRET__DBA_CLICKHOUSE_PASSWORD:-${DBA_CLICKHOUSE_PASSWORD:-${THONNAS_DBA_FLEET_PASSWORD:-}}}"
if [ -z "${PASSWORD}" ]; then
  echo "dba-clickhouse: SECRET__DBA_CLICKHOUSE_PASSWORD (or DBA_CLICKHOUSE_PASSWORD) is required" >&2
  exit 1
fi

# @intent Wait for native server before CREATE USER (Keeper may already be healthy)
READY=0
for _ in $(seq 1 60); do
  if clickhouse-client --query "SELECT 1" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ "${READY}" != "1" ]; then
  echo "dba-clickhouse: server not ready for user bootstrap" >&2
  exit 1
fi

# @intent Idempotent: create or update password so restart with same secret stays valid
clickhouse-client --query "CREATE USER IF NOT EXISTS thonnas IDENTIFIED WITH sha256_password BY '${PASSWORD}'"
clickhouse-client --query "ALTER USER thonnas IDENTIFIED WITH sha256_password BY '${PASSWORD}'"
clickhouse-client --query "GRANT CURRENT GRANTS ON *.* TO thonnas"
echo "dba-clickhouse: thonnas user ready"

