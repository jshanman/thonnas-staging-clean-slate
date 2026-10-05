---
root: false
targets: ["*"]
globs:
  - "components/metrics-otel-signoz/**"
---

# metrics-otel-signoz

SigNoz OTEL collector for observability. Peers `@thonnas/dba-clickhouse` for telemetry storage (`infra.compute.fleet.dba`). Does not own ClickHouse server/Keeper.

**Root:** `components/metrics-otel-signoz`

**Strategies:**
- [`observe.metrics.otel`](../../docs/rules/strategies/metrics-otel-signoz--observe.metrics.otel.md) - OTLP collection
- [`observe.apm.signoz`](../../docs/rules/strategies/metrics-otel-signoz--observe.apm.signoz.md) - APM traces
- [`observe.dashboard`](../../docs/rules/strategies/metrics-otel-signoz--observe.dashboard.md) - Local dashboards (prod: dashboard-signoz)
- [`observe.errors`](../../docs/rules/strategies/metrics-otel-signoz--observe.errors.md) - Error tracking

## Lifecycle Context
- **Requirements:** [review](../../docs/thonnas-prompts/planning.requirements.review.md)

