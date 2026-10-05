package thonnas

import (
	thonnascache "thonnas/api-go/internal/common/thonnas/cache"
	thonnasmetrics "thonnas/api-go/internal/common/thonnas/metrics"
	thonnasworker "thonnas/api-go/internal/common/thonnas/worker"

	"thonnas/api-go/internal/thonnas/contracts"
)

// Bundle holds portable Thonnas contracts for modules plus internal backends for shutdown.
//
// @intent Feature modules use ThonnasMetrics/ThonnasCache/ThonnasWorker only; vendor types stay in wiring
type Bundle struct {
	metricsBackend thonnasmetrics.MetricsProvider
	cacheBackend   thonnascache.CacheProvider
	workerRegistry *thonnasworker.JobRegistry

	ThonnasMetrics contracts.ThonnasMetrics
	ThonnasCache   contracts.ThonnasCache
	ThonnasWorker  contracts.ThonnasWorker
	ThonnasHealth  contracts.ThonnasHealth
	ThonnasLogger  contracts.ThonnasLogger
	ThonnasEmail   contracts.ThonnasEmail
	ThonnasEvents  contracts.ThonnasEvents
}

// WorkerRegistry returns the collected job registry for worker backend modules.
func (b *Bundle) WorkerRegistry() *thonnasworker.JobRegistry {
	if b == nil {
		return nil
	}
	return b.workerRegistry
}

// ShutdownMetrics closes the vendor metrics backend (OTLP meter provider, etc.).
func (b *Bundle) ShutdownMetrics() error {
	if b == nil || b.metricsBackend == nil {
		return nil
	}
	return b.metricsBackend.Close()
}

// ShutdownCache closes the vendor cache backend (Redis client, etc.).
func (b *Bundle) ShutdownCache() error {
	if b == nil || b.cacheBackend == nil {
		return nil
	}
	return b.cacheBackend.Close()
}

