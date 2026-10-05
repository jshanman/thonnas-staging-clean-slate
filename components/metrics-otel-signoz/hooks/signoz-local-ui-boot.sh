#!/usr/bin/env bash
# @intent Boot local metrics Signoz UI with fleet password mapped at runtime
set -eu

_host="${THONNAS_DBA_FLEET_HOST:-dba-clickhouse}"
_port="${THONNAS_DBA_FLEET_PORT:-9000}"
_user="${THONNAS_DBA_FLEET_USER:-thonnas}"
_pass="${THONNAS_DBA_FLEET_PASSWORD:-${SECRET__DBA_CLICKHOUSE_PASSWORD:-${SECRET__THONNAS_DBA_FLEET_PASSWORD:-}}}"

export SIGNOZ_TELEMETRYSTORE_PROVIDER=clickhouse
export SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN="tcp://${_host}:${_port}?username=${_user}&password=${_pass}"
export SIGNOZ_SQLSTORE_SQLITE_PATH="${SIGNOZ_SQLSTORE_SQLITE_PATH:-/var/lib/signoz/signoz.db}"
export SIGNOZ_ALERTMANAGER_PROVIDER="${SIGNOZ_ALERTMANAGER_PROVIDER:-signoz}"
export STORAGE="${STORAGE:-clickhouse}"
export DASHBOARDS_PATH="${DASHBOARDS_PATH:-/root/config/dashboards}"

if [ -x /root/signoz ]; then
  exec /root/signoz server --config=/root/config/prometheus.yml
fi
exec signoz server --config=/root/config/prometheus.yml

