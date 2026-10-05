# metrics-otel-signoz Component

SigNoz OTEL collector (and local UI helper) for Thonnas applications. Production storage peers `@thonnas/dba-clickhouse` on `infra.compute.fleet.dba` — this package does **not** own ClickHouse server/Keeper.

## Features

- OTLP gRPC/HTTP collectors for in-cluster and local exporters
- Package-owned boot hook mapping `THONNAS_DBA_FLEET_*` → SigNoz product DSNs
- Local compose UI for DX (production `infra.observe.dashboard` lives in `dashboard-signoz`)
- Exported collector host and endpoint configuration for other components

## Install

Use this component from the workspace root through the Thonnas CLI:

```bash
thonnas component build components/metrics-otel-signoz --yes --ai-provider inline
```

## Usage

Start the store first (`@thonnas/dba-clickhouse` on `thonnas-network`), then this collector:

```bash
docker compose -f components/dba-clickhouse/docker-compose.yml up -d
docker compose -f components/metrics-otel-signoz/docker-compose.yml up -d
```

Point OTLP exporters at the exported gRPC endpoint (default `metrics-otel-signoz-collector:4317`). Open the SigNoz UI on port `18080` for local dashboards (or use `dashboard-signoz` in production).

## Configuration

Primary exports are defined in `thonnas-config.json`:

- `METRICS_OTEL_SIGNOZ_INTERNAL_HOST`
- `METRICS_OTEL_SIGNOZ_INTERNAL_GRPC_PORT`
- `METRICS_OTEL_SIGNOZ_INTERNAL_HTTP_PORT`
- `METRICS_OTEL_SIGNOZ_GRPC_ENDPOINT`
- `METRICS_OTEL_GRPC_ENDPOINT`

Fleet/store wiring (injected by apply / compose):

- `THONNAS_DBA_FLEET_HOST` / `THONNAS_DBA_FLEET_PORT` / `THONNAS_DBA_FLEET_USER` / `THONNAS_DBA_FLEET_PASSWORD`

See `docs/metrics-otel-signoz_overview.md` for local setup and integration details.

## Testing

Build and pack the component from the workspace root:

```bash
thonnas component build components/metrics-otel-signoz --yes --ai-provider inline
thonnas component pack components/metrics-otel-signoz --yes
```

For runtime validation, start `dba-clickhouse` + this stack and confirm the OTLP collectors are reachable on the shared `thonnas-network`.

