package health

import (
	"context"
	"fmt"
	"sync"
	"time"

	"thonnas/api-go/internal/thonnas/contracts"
)

const defaultHealthTimeoutMs = 5000

type probe struct {
	fn        contracts.HealthCheckFn
	timeoutMs int
}

// Registry implements contracts.ThonnasHealth for injectable readiness probes.
//
// @intent Colocated with HTTP health routes in this package (same layout as api-nest Thonnas health)
type Registry struct {
	mu     sync.RWMutex
	probes map[string]probe
}

// NewRegistry constructs an empty registry (core/module probes register at bootstrap).
func NewRegistry() *Registry {
	return &Registry{probes: make(map[string]probe)}
}

// AddHealthCheck registers or replaces a probe by id.
func (r *Registry) AddHealthCheck(checkID string, fn contracts.HealthCheckFn, timeoutMs ...int) {
	t := defaultHealthTimeoutMs
	if len(timeoutMs) > 0 && timeoutMs[0] > 0 {
		t = timeoutMs[0]
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.probes[checkID] = probe{fn: fn, timeoutMs: t}
}

// RemoveHealthCheck drops a probe by id.
func (r *Registry) RemoveHealthCheck(checkID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.probes, checkID)
}

// RunAllChecks executes probes sequentially with each probe's timeout.
func (r *Registry) RunAllChecks(ctx context.Context) (map[string]contracts.HealthCheckSnapshot, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]contracts.HealthCheckSnapshot, len(r.probes))
	for id, p := range r.probes {
		out[id] = r.runOne(ctx, id, p)
	}
	return out, nil
}

func (r *Registry) runOne(parentCtx context.Context, checkID string, p probe) contracts.HealthCheckSnapshot {
	start := time.Now()
	runCtx, cancel := context.WithTimeout(parentCtx, time.Duration(p.timeoutMs)*time.Millisecond)
	defer cancel()

	done := make(chan contracts.HealthCheckSnapshot, 1)
	go func() {
		res, err := p.fn(runCtx)
		latency := time.Since(start).Milliseconds()
		var snap contracts.HealthCheckSnapshot
		if err != nil && res == nil {
			snap = contracts.HealthCheckSnapshot{
				CheckID:   checkID,
				Status:    contracts.HealthStatusUnhealthy,
				Message:   err.Error(),
				LatencyMs: latency,
			}
		} else {
			if res == nil {
				res = &contracts.HealthCheckResult{Status: contracts.HealthStatusHealthy}
			}
			st := res.Status
			if st == "" {
				st = contracts.HealthStatusHealthy
			}
			msg := res.Message
			if err != nil {
				if msg == "" {
					msg = err.Error()
				}
				st = contracts.HealthStatusUnhealthy
			}
			lm := res.LatencyMs
			if lm <= 0 {
				lm = latency
			}
			snap = contracts.HealthCheckSnapshot{
				CheckID:   checkID,
				Status:    st,
				Message:   msg,
				LatencyMs: lm,
				Details:   res.Details,
			}
		}
		select {
		case done <- snap:
		case <-runCtx.Done():
		}
	}()

	select {
	case snap := <-done:
		return snap
	case <-runCtx.Done():
		return contracts.HealthCheckSnapshot{
			CheckID:   checkID,
			Status:    contracts.HealthStatusUnhealthy,
			Message:   fmt.Sprintf("timeout after %dms", p.timeoutMs),
			LatencyMs: time.Since(start).Milliseconds(),
		}
	}
}

var _ contracts.ThonnasHealth = (*Registry)(nil)

