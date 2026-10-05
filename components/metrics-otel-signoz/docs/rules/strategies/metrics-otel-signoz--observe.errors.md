# Strategy Implementation: observe.errors

SigNoz groups OTEL exception events, surfaces error rates, and powers alerting/triage workflows. Exception storage uses the peer `@thonnas/dba-clickhouse` store.

## Pipeline

1. Instrumented services emit OTLP spans/metrics with exception attributes.
2. `otel-collector` processes the data (`resources/otel-collector-config.yaml`) and writes to the peer fleet store.
3. SigNoz UI renders error rate charts, exception groups, and stack traces; alerts are defined in `resources/common/signoz/prometheus.yml`.

## Configuration

- Ensure exporters set `exception.message`, `exception.type`, and `exception.stacktrace`—SigNoz uses these fields for grouping.
- Retention / aggregation tuning belongs in `@thonnas/dba-clickhouse`, not this package's historical `resources/common/clickhouse/` copies.
- Create alert rules for error rates (e.g., >5% over 5m) inside Prometheus config.

## Operations

- Use the “Exceptions” tab in SigNoz UI to review grouped errors.
- If error data stops flowing, inspect collector logs for batch processor backpressure or peer store availability (`THONNAS_DBA_FLEET_HOST`).

