package thonnascache

import (
	"context"
	"sync"

	"thonnas/api-go/internal/thonnas/contracts"
)

// NoOpCacheProvider implements CacheProvider with in-process set semantics.
type NoOpCacheProvider struct {
	mu   sync.RWMutex
	sets map[string]map[string]struct{}
}

var _ contracts.ThonnasCache = (*NoOpCacheProvider)(nil)
var _ CacheProvider = (*NoOpCacheProvider)(nil)

// NewNoOpCacheProvider creates an in-memory cache provider for tests and disabled deployments.
func NewNoOpCacheProvider() *NoOpCacheProvider {
	return &NoOpCacheProvider{sets: make(map[string]map[string]struct{})}
}

func (n *NoOpCacheProvider) ensureSet(key string) map[string]struct{} {
	if n.sets[key] == nil {
		n.sets[key] = make(map[string]struct{})
	}
	return n.sets[key]
}

func (n *NoOpCacheProvider) SetAdd(_ context.Context, key string, member string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.ensureSet(key)[member] = struct{}{}
	return nil
}

func (n *NoOpCacheProvider) SetRemove(_ context.Context, key string, member string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.ensureSet(key), member)
	return nil
}

func (n *NoOpCacheProvider) SetCardinality(_ context.Context, key string) (int, error) {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return len(n.sets[key]), nil
}

func (n *NoOpCacheProvider) Close() error { return nil }

