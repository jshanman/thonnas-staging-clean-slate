# Component: API - Go

## Summary

High-performance Go API service for WebSocket, real-time features, file processing, and CPU-intensive operations. Uses NestJS-inspired module pattern.

## When to Use

Use for high concurrency (10k+ connections), WebSocket/real-time features, file uploads, CPU-intensive operations, streaming, and performance-critical paths.

**Specific Use Cases**:
- WebSocket servers handling 10k+ concurrent connections
- Real-time messaging and chat applications
- File upload and processing services
- Video/image processing pipelines
- CPU-intensive computational tasks
- High-throughput streaming operations
- Low-latency performance-critical APIs
- Connection pooling and management
- Real-time dashboards and analytics
- IoT device communication hubs

## When NOT to Use

Avoid for complex business logic workflows, database CRUD operations, or when TypeScript/NestJS patterns are preferred.

**Anti-patterns**:
- Complex ORM-based database operations
- Business logic with extensive data validation
- Rapid prototyping with frequent schema changes
- Applications requiring TypeScript ecosystem
- When team expertise is primarily Node.js/TypeScript

For these use cases, prefer frameworks with rich ORM support like NestJS or Django.

## Technology Stack

- **Language**: Go
- **Framework**: Custom (NestJS-inspired module pattern)
- **WebSocket**: gorilla/websocket
- **HTTP**: net/http, chi/gorilla mux
- **Database**: PostgreSQL (pgx driver)
- **Metrics**: Prometheus, OpenTelemetry
- **Testing**: Go testing package

## Integration Points

- **Databases**: PostgreSQL for data persistence
- **Queue**: MQTT for pub/sub messaging
- **Workers**: Workflow orchestration for background jobs
- **Monitoring**: Prometheus metrics, OpenTelemetry traces
- **Cache**: Redis for session/connection state

## Configuration

Go API configuration includes:
- Connection pool settings
- WebSocket configuration
- Goroutine limits
- Request timeouts
- Rate limiting
- CORS settings

---

# Go Language Guidelines


# Go API Development Rules (api-go)

## Module Pattern (MANDATORY)

Every module MUST have `module.go` with: Module struct, `BuildModule()` (early build), `NewModule()` (full DI), Repository → Service → Handler wiring.

```go
type Module struct {
    config *config.Config
    logger *logger.Logger
    metrics metrics.MetricsProvider
    service Service
    repository Repository
    handler *Handler
}

func BuildModule(cfg *config.Config, log *logger.Logger, metrics metrics.MetricsProvider) (*Module, error) {
    return &Module{config: cfg, logger: log, metrics: metrics}, nil
}

func NewModule(cfg *config.Config, log *logger.Logger, metrics metrics.MetricsProvider, dep DependencyInterface) (*Module, error) {
    repo := NewRepository(log, cfg)
    service := NewService(log, repo, dep)
    handler := NewHandler(log, service)
    return &Module{config: cfg, logger: log, metrics: metrics, service: service, repository: repo, handler: handler}, nil
}
```

Cross-module communication: Interfaces only, NO concrete imports. `mqtt.MQTTClient` interface, NOT `mqtt/paho.PahoMQTTClient`.

## Error Handling

Use `internal/shared/errors`. Wrap errors: `fmt.Errorf("failed to X: %w", err)`. Log before returning. Handler pattern:
```go
if err != nil {
    log.WithField("error", err.Error()).Error("Operation failed")
    c.JSON(500, gin.H{"error": "Internal server error"})
    return
}
```
Use `defer` for cleanup. Recover panics in goroutines.

## Concurrency

Use `sync.Mutex` for shared state, `sync.RWMutex` for read-heavy, `atomic.Int64` for counters. Goroutines: Always defer cleanup, use context for cancellation, ensure exit conditions. Channels: Buffered with non-blocking select, close in sender.

## Logging (MANDATORY)

Structured logging: `logger.WithFields()`. Levels: Debug (detailed flow), Info (events/state), Warn (retries/degraded), Error (failures), Fatal (unrecoverable). Don't log: JWT tokens, passwords, secrets, full payloads in production.

## WebSocket

One goroutine per connection (readPump, writePump). Defer cleanup, remove from pool. Set deadlines. Validate message size, parse JSON safely, handle unknown types gracefully. Non-blocking broadcasts.

## Naming Conventions

Package: One folder = one package, name = folder name (lowercase), avoid `utils/common/helpers`. Exported: PascalCase. Unexported: camelCase. Avoid stuttering in package context. Interfaces: `-er` suffix for behavior, descriptive names for services. Constructors: `New{Type}()`. Functions: Verb-based, CamelCase. Constants: PascalCase exported, camelCase unexported, use `iota`.

## Code Structure

Imports: Group stdlib, external, internal with blank lines. Comments: Package doc, exported function docs, interface contracts, inline "why" not "what". Module path: `thonnas/api-go` internally.

## Testing

File: `{file}_test.go`. Use testify assert/require. Mock interfaces. Table-driven tests.

## Performance

Reuse buffers (sync.Pool), pre-allocate slices, avoid allocations in hot paths, profile first. JSON: Marshal once for broadcasts, use `json.RawMessage`.

## Module Creation

Create when: Distinct domain, multiple endpoints, injectable dependencies, complex enough, needs testability. Don't create for: Single endpoint (add to existing), utilities (use `internal/shared/`), middleware (use `internal/middleware/`).

## Enforcement Checklist

- [ ] Module has `module.go` with BuildModule/NewModule
- [ ] All dependencies are interfaces (not concrete)
- [ ] Services accept interface dependencies
- [ ] No cross-module concrete imports
- [ ] Repository → Service → Handler pattern
- [ ] SOLID principles followed
- [ ] Independently testable with mocks

## Mandatory Rules

1. Module pattern: Handler → Service → Repository in `module.go` (NON-NEGOTIABLE)
2. Interfaces: ALL services/dependencies are interfaces (MANDATORY)
3. Module isolation: No cross-module concrete imports, only interfaces (MANDATORY)
4. Dependency injection: All via constructors, no direct instantiation (MANDATORY)
5. Testability: Mock-anything approach, all dependencies are interfaces (MANDATORY)
6. SOLID: Single responsibility, interface segregation, dependency inversion (MANDATORY)
7. Error handling: Wrap errors, log with context, return gracefully
8. Concurrency: Goroutines with cleanup, channels with care, atomic counters
9. Logging: Structured with fields, appropriate levels
10. Testing: Unit tests with mocked interfaces, integration with real components

