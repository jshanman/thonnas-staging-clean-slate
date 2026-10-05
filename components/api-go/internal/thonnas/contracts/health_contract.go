package contracts

import "context"

// HealthCheckStatus mirrors @thonnas/contracts HealthCheckStatus.
type HealthCheckStatus string

const (
	HealthStatusHealthy   HealthCheckStatus = "healthy"
	HealthStatusUnhealthy HealthCheckStatus = "unhealthy"
	HealthStatusDegraded  HealthCheckStatus = "degraded"
)

// HealthCheckResult is returned by probe callbacks (e.g. cache, database, external HTTP checks).
type HealthCheckResult struct {
	Status    HealthCheckStatus `json:"status"`
	Message   string            `json:"message,omitempty"`
	LatencyMs int64             `json:"latencyMs,omitempty"`
	Details   map[string]any    `json:"details,omitempty"`
}

// HealthCheckSnapshot is emitted after each probe runs (runner sets CheckID and timing).
type HealthCheckSnapshot struct {
	CheckID   string            `json:"checkId"`
	Status    HealthCheckStatus `json:"status"`
	Message   string            `json:"message,omitempty"`
	LatencyMs int64             `json:"latencyMs"`
	Details   map[string]any    `json:"details,omitempty"`
}

// HealthCheckFn is invoked under optional per-check timeout by the registry.
// Non-nil error maps to unhealthy unless the implementation prefers returning Result only.
type HealthCheckFn func(ctx context.Context) (*HealthCheckResult, error)

// ThonnasHealth registers portable probes without importing Gin/Nest.
type ThonnasHealth interface {
	AddHealthCheck(checkID string, fn HealthCheckFn, timeoutMs ...int)
	RemoveHealthCheck(checkID string)
	RunAllChecks(ctx context.Context) (map[string]HealthCheckSnapshot, error)
}

