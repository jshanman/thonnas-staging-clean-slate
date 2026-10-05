# Strategy Implementation: observe.metrics.otel

SigNoz ships the OpenTelemetry collection pipeline—auto-instrumented services send metrics to the OTEL collector which forwards data into the peer `@thonnas/dba-clickhouse` store (`infra.compute.fleet.dba`).

## Key Files

- `docker-compose.yml` – defines `otel-collector` (+ local `signoz` UI); peers `dba-clickhouse` on `thonnas-network`.
- `hooks/signoz-collector-boot.sh` – maps `THONNAS_DBA_FLEET_*` → `SIGNOZ_*` DSNs, migrates, execs collector.
- `resources/otel-collector-config.yaml` – upstream SigNoz collector pipeline (receivers/processors/exporters).
- `resources/common/signoz/prometheus.yml` – built-in metrics scraping + dashboards.

## Implementation Notes

1. **Collector Endpoints** – Ports `4317` (gRPC) and `4318` (HTTP) are exposed by `otel-collector`. Use `metrics-otel-signoz-collector:4317` inside the Docker network.
2. **Store peer** – Compose defaults `THONNAS_DBA_FLEET_HOST=dba-clickhouse`. Staging/production `thonnas-infra` peers `infra.compute.fleet.dba`.
3. **Config Overrides** – Modify `resources/otel-collector-config.yaml` to add processors. Restart the collector after editing.
4. **Dashboards** – Local UI reads dashboards from `resources/common/dashboards`. Production dashboard key is owned by `dashboard-signoz`.

## Testing

- Start `dba-clickhouse`, then `docker compose up` for this package.
- Hit `http://localhost:8080/api/v1/health` to verify local SigNoz health endpoint.
- Use collector logs to confirm OTLP connections and successful migrate against the peer store.

## Pitfalls

- Collector fails closed if neither `THONNAS_DBA_FLEET_HOST` nor `THONNAS_DBA_FLEET_DSN` is set.
- Do not reintroduce ClickHouse server images into this package — store ownership is `dba-clickhouse`.

