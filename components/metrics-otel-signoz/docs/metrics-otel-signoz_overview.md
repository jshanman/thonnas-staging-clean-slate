# Component Overview · metrics-otel-signoz

SigNoz provides the OTEL collector path for Baseline Cursor v3. Production staging/production declare **only** `infra.observe.metrics` and peer `infra.compute.fleet.dba`. ClickHouse server/Keeper ownership lives in `@thonnas/dba-clickhouse`. Local compose may still start the SigNoz UI for DX; production dashboards belong in `dashboard-signoz`.

## Responsibilities

- Expose OTLP gRPC/HTTP collectors (`4317/4318`) for APIs, workers, mobile simulators, and browser agents.
- Map portable `THONNAS_DBA_FLEET_*` into SigNoz product DSNs via `hooks/signoz-collector-boot.sh`.
- Keep collector config / Prometheus scrape defs versioned under `resources/`.
- Depend on `@thonnas/dba-clickhouse` for the telemetry store — do not run ClickHouse server images here.

## Directory Layout

```
components/metrics-otel-signoz/
├── docker-compose.yml                # Collector (+ local UI); peers dba-clickhouse
├── hooks/
│   └── signoz-collector-boot.sh      # Fleet env → SIGNOZ_* + migrate + exec
├── docs/
│   ├── metrics-otel-signoz_overview.md
│   └── rules/
│       ├── metrics-otel-signoz.md
│       └── strategies/
├── resources/
│   ├── common/
│   │   ├── clickhouse/               # HISTORICAL — ownership → dba-clickhouse (see OWNERSHIP.md)
│   │   ├── dashboards/               # SigNoz dashboard bundles (local DX)
│   │   └── signoz/                   # Prometheus + OTEL manager configs
│   └── otel-collector-config.yaml    # OTLP pipeline definition
└── thonnas-package.json
```

## Running Locally

1. Ensure the root orchestration network exists by running `docker compose -f components/infra-docker/docker-compose.yml up -d`.
2. Start `@thonnas/dba-clickhouse` on `thonnas-network` (this package no longer owns CH/Keeper services).
3. Bring up this compose file; collector `depends_on` `dba-clickhouse` when present in the same project (`required: false` otherwise).
4. Default credentials/ports match upstream SigNoz releases (`v0.98.0` / collector `v0.129.7`).

## Integration Contracts

- **OTLP gRPC**: `metrics-otel-signoz-collector:4317` (DNS alias provided in compose). Preferred endpoint for services running inside the Docker network.
- **OTLP HTTP**: `metrics-otel-signoz-collector:4318`.
- **SigNoz UI (local)**: `http://localhost:18080`. Production UI: `dashboard-signoz`.
- **Store DSN**: from `dba-clickhouse` / `THONNAS_DBA_FLEET_*` (compose default host `dba-clickhouse:9000`).
- **Dashboards**: Located under `resources/common/dashboards` for local DX; production dashboard package may supersede.

## Strategy Mapping

| Strategy | Implementation Notes |
| --- | --- |
| `observe.metrics.otel` | SigNoz OTEL collector writes into the peer fleet store (`dba-clickhouse`). |
| `observe.dashboard` | Local UI helper only; production key is owned by `dashboard-signoz`. |
| `observe.errors` | Collector + SigNoz UI surface exception groups, error alerts, and triage views. |
| `observe.apm.signoz` | Flame graphs, span analysis, and service maps provided by SigNoz. |

`storage.columnar.clickhouse` is **not** implemented here — store strategy is `infra.compute.fleet.dba` on `@thonnas/dba-clickhouse`.

## Dependencies

- Depends on `@thonnas/dba-clickhouse` (`^0.1.0-beta.0`) and `@thonnas/infra-docker`.
- Staging/production `thonnas-infra` peers `infra.compute.fleet.dba`.
- Consumed by `api-nest`, `api-go`, and any other OTEL-enabled components.

## Operational Notes

- Collector boot hook runs migrate bootstrap/sync/async against the peer store before serving OTLP.
- All services include `com.thonnas.*` labels plus `@intent` comments to satisfy AI installation requirements.
- Do not reintroduce `clickhouse/clickhouse-server` or ZooKeeper images into this compose file.

## Next Steps / Customization

- Update SigNoz version variables (`VERSION`, `OTELCOL_TAG`) in the compose file when upgrading.
- Extend dashboards or alert rules by editing the files in `resources/common/dashboards` and `resources/common/signoz/prometheus.yml`.
- Store retention, XML, and UDF ownership: see `@thonnas/dba-clickhouse`.

