#!/usr/bin/env bash
# @intent Package-owned Signoz collector boot (not imported by ecs-fargate.ts)
# Maps portable THONNAS_DBA_FLEET_* → SIGNOZ product DSNs, runs collector migrations,
# then execs the Signoz OTEL collector.
set -eu

_host="${THONNAS_DBA_FLEET_HOST:-}"
_port="${THONNAS_DBA_FLEET_PORT:-9000}"
_user="${THONNAS_DBA_FLEET_USER:-thonnas}"
# @intent Prefer portable fleet password; fall back to compose SECRET__ from dba-clickhouse
_pass="${THONNAS_DBA_FLEET_PASSWORD:-${SECRET__DBA_CLICKHOUSE_PASSWORD:-${SECRET__THONNAS_DBA_FLEET_PASSWORD:-}}}"
_dsn="${THONNAS_DBA_FLEET_DSN:-}"

if [ -z "${_dsn}" ] && [ -z "${_host}" ]; then
  echo "THONNAS_DBA_FLEET_HOST (or THONNAS_DBA_FLEET_DSN) is required — apply must wire fleet/store env" >&2
  exit 1
fi

if [ -n "${_host}" ]; then
  _base="tcp://${_host}:${_port}?username=${_user}&password=${_pass}"
  export SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_DSN="${_base}"
  export SIGNOZ_TRACES_DSN="tcp://${_host}:${_port}/signoz_traces?username=${_user}&password=${_pass}"
  export SIGNOZ_METRICS_DSN="tcp://${_host}:${_port}/signoz_metrics?username=${_user}&password=${_pass}"
  export SIGNOZ_LOGS_DSN="tcp://${_host}:${_port}/signoz_logs?username=${_user}&password=${_pass}"
else
  export SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_DSN="${_dsn}"
  export SIGNOZ_TRACES_DSN="${_dsn}"
  export SIGNOZ_METRICS_DSN="${_dsn}"
  export SIGNOZ_LOGS_DSN="${_dsn}"
fi

# @intent Migrator reads DSN from env (flags unsupported on some collector builds)
export SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_CLUSTER="${SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_CLUSTER:-cluster}"
export SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_REPLICATION="${SIGNOZ_OTEL_COLLECTOR_CLICKHOUSE_REPLICATION:-false}"
export SIGNOZ_OTEL_COLLECTOR_TIMEOUT="${SIGNOZ_OTEL_COLLECTOR_TIMEOUT:-10m}"

echo "Running Signoz ClickHouse migrations..."
/signoz-otel-collector migrate bootstrap
/signoz-otel-collector migrate sync up
/signoz-otel-collector migrate async up
/signoz-otel-collector migrate sync check

# Prefer mounted package config when present; otherwise write a minimal traces pipeline
if [ -f /etc/otel-collector-config.yaml ]; then
  exec /signoz-otel-collector --config=/etc/otel-collector-config.yaml
fi

cat >/tmp/otel.yaml <<'EOF'
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  batch: {}
exporters:
  clickhousetraces:
    datasource: ${env:SIGNOZ_TRACES_DSN}
    use_new_schema: true
service:
  pipelines:
    traces: { receivers: [otlp], processors: [batch], exporters: [clickhousetraces] }
EOF
exec /signoz-otel-collector --config=/tmp/otel.yaml

