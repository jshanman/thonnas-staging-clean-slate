---
root: false
targets: ["*"]
globs:
  - "components/api-go/**"
---

# api-go

High-performance Go API for WebSocket, real-time features, file processing, and CPU-intensive operations. NestJS-inspired module pattern. Handles 10k+ concurrent connections.

**Root:** `components/api-go`

**Deep Dive** 
- Read when creating code within this component: [`overview`](../../docs/rules/api-go.md) - REST API patterns

**Strategies:**
- [`auth.jwt`](../../docs/rules/strategies/api-go--auth.jwt.md) - JWT validation
- [`comms.http.rest`](../../docs/rules/strategies/api-go--comms.http.rest.md) - REST endpoints
- [`comms.duplex.websocket`](../../docs/rules/strategies/api-go--comms.duplex.websocket.md) - WebSocket
- [`observe.metrics.prometheus`](../../docs/rules/strategies/api-go--observe.metrics.prometheus.md) - Prometheus metrics
- [`observe.logging.structured`](../../docs/rules/strategies/api-go--observe.logging.structured.md) - Structured logs
- [`config.env`](../../docs/rules/strategies/api-go--config.env.md) - Environment config

## Lifecycle Context
- **Requirements:** [review](../../docs/thonnas-prompts/planning.requirements.review.md)
- **Coding:** [verify](../../docs/thonnas-prompts/coding.verify.md)

