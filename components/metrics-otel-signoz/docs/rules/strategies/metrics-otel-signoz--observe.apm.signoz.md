# Strategy Implementation: observe.apm.signoz

The SigNoz bundle exposes full APM capabilities—service maps, flame graphs, span analysis, latency breakdowns, and root-cause exploration. Spans are stored in the peer `@thonnas/dba-clickhouse` fleet store.

## Key Behaviors

- **Automatic Service Discovery** – OTEL spans include `service.name`; SigNoz builds dependency/service maps automatically.
- **Flame Graphs & Traces** – Stored via the peer ClickHouse implementation and rendered via the SigNoz UI.
- **Span Attributes** – User-defined span attributes drive filtering. Add business context in instrumented services for better triage.

## Configuration Points

- Update `resources/otel-collector-config.yaml` to add span processors (tail sampling, attribute filters, redaction).
- Use SigNoz UI > Settings to configure latency objectives (Apdex, percentiles).
- Retention / disk / XML ownership: `@thonnas/dba-clickhouse` (`infra.compute.fleet.dba`) — not this package.

## Validation Checklist

- After startup, open Service Map and confirm instrumented service nodes appear once they emit OTLP spans.
- Run a sample request and inspect Flame Graph to ensure spans contain expected attributes.

