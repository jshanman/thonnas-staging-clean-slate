package thonnasworker

import (
	"fmt"
	"sync"

	"thonnas/api-go/internal/thonnas/contracts"
)

// JobRegistry implements contracts.ThonnasWorker by collecting jobs during module bootstrap.
type JobRegistry struct {
	mu   sync.RWMutex
	jobs map[string]contracts.ThonnasJob
}

var _ contracts.ThonnasWorker = (*JobRegistry)(nil)

// NewJobRegistry creates an empty in-process job registry.
func NewJobRegistry() *JobRegistry {
	return &JobRegistry{jobs: make(map[string]contracts.ThonnasJob)}
}

func (r *JobRegistry) RegisterJob(job contracts.ThonnasJob) error {
	if job == nil {
		return fmt.Errorf("job is nil")
	}
	id := job.GetID()
	if id == "" {
		return fmt.Errorf("job id is required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.jobs[id]; exists {
		return fmt.Errorf("job already registered: %s", id)
	}
	r.jobs[id] = job
	return nil
}

func (r *JobRegistry) ListJobs() ([]contracts.ThonnasJob, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]contracts.ThonnasJob, 0, len(r.jobs))
	for _, job := range r.jobs {
		out = append(out, job)
	}
	return out, nil
}

