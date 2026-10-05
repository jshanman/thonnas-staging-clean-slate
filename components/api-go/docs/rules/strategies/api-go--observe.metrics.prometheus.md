# Strategy Implementation: observe.metrics.prometheus

**Component/Module:** api-go  
**Strategy:** `observe.metrics.prometheus`  
**Category:** observe.metrics  
**Purpose:** Prometheus metrics

---

## Implementation Approach

### Overview

api-go exports metrics through portable Thonnas contracts. The standalone component ships noop wiring by default; installable metrics packages can bind OpenTelemetry or Prometheus exporters without coupling feature code to vendor SDK types.

### Technology Stack

- **Metrics Library:** `go.opentelemetry.io/otel` - OpenTelemetry Go SDK
- **Exporter:** `otlp/otlpmetric/otlpmetricgrpc` - OTLP gRPC exporter
- **Instrument Types:** Counters (monotonic), Gauges (up/down), Histograms (distributions)
- **Backend:** SigNoz, Prometheus, Jaeger, Datadog (any OTLP-compatible)

### Key Components

- **Metrics contracts** (`internal/thonnas/contracts`) - Shared metric names and recording ports
- **Noop wiring** (`internal/common/thonnas/metrics`) - Safe default when no exporter package is installed
- **Installable adapter packages** - Bind OTLP/Prometheus exporters at composition roots
- **Metric Instruments** - Counters, UpDownCounters (gauges), Histograms
- **Lazy Creation** - Instruments created on first use, cached for reuse
- **Labels/Attributes** - Key-value pairs for metric dimensions

---

## Code Patterns

### Basic Usage

```go
// Bootstrap resolves metrics via thonnas.NewBundle(cfg, log); feature code uses contracts only.
sampleThonnasMetrics.RecordCounter(
    contracts.MetricHTTPRequestsTotal,
    contracts.StringMapToThonnasAttributes(map[string]string{
        contracts.LabelMethod: "GET",
        contracts.LabelPath: "/api/users",
        contracts.LabelStatus: "200",
    }),
)
```

---

## Configuration

### Required Settings

- `METRICS_ENABLED` - Enable metrics collection (default: true)
- `METRICS_PROVIDER` - Provider type: opentelemetry or noop (default: opentelemetry)
- `OTEL_ENDPOINT` - OpenTelemetry collector endpoint (default: localhost:4317)
- `SERVICE_NAME` - Service name for metrics identification
- `ENVIRONMENT` - Environment label: development, staging, production

---

## Best Practices

- Use appropriate instrument types for counters, gauges, and histograms.
- Keep label cardinality low to avoid metric explosion.
- Cache instruments after first creation.
- Keep feature code on portable contracts, not vendor SDK types.

---

## Related Strategies

- [`observe.logging.structured`](api-go--observe.logging.structured.md) - Logs complement metrics
- [`comms.duplex.websocket`](api-go--comms.duplex.websocket.md) - WebSocket metrics tracking

