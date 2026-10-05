---
alwaysApply: true
description:
---

# Component: metrics-otel-signoz

## Summary

SigNoz OTEL collector providing OTLP ingestion, APM/metrics pipelines, and local UI helper. Telemetry storage peers `@thonnas/dba-clickhouse` (`infra.compute.fleet.dba`) — this package does not own ClickHouse server/Keeper.

## When to Use

- Baseline project requires local OTEL backend (metrics + traces) without external SaaS.
- Need SigNoz collector + dashboards/alerts for debugging (local compose or with `dashboard-signoz`).
- Want version-controlled collector configs inside the repo.

## When NOT to Use

- Cloud provider already offers managed SigNoz and you prefer a remote backend.
- Only Prometheus scraping needed (use Prometheus-specific component instead).
- You need to install/configure ClickHouse itself — use `@thonnas/dba-clickhouse`.

## Technology Stack

- SigNoz `v0.98.0` (local UI helper)
- SigNoz OTEL Collector `v0.129.7` + package boot hook
- Peer store: `@thonnas/dba-clickhouse` on `infra.compute.fleet.dba`

## Integration Points

- `signoz-otel-collector:4317/4318` for OTLP exporters (gRPC + HTTP).
- SigNoz UI at `http://localhost:18080` for local dashboards/APM views (production: `dashboard-signoz`).
- Store via `THONNAS_DBA_FLEET_*` / compose service `dba-clickhouse`.

