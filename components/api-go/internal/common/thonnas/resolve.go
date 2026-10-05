package thonnas

import (
	"fmt"

	"thonnas/api-go/internal/common/logger"
	thonnasemail "thonnas/api-go/internal/common/thonnas/email"
	thonnasevents "thonnas/api-go/internal/common/thonnas/events"
	thonnasworker "thonnas/api-go/internal/common/thonnas/worker"
	thonnascache "thonnas/api-go/internal/common/thonnas/cache"
	commonhealth "thonnas/api-go/internal/common/thonnas/health"
	thonnaslogger "thonnas/api-go/internal/common/thonnas/logger"
	thonnasmetrics "thonnas/api-go/internal/common/thonnas/metrics"
	"thonnas/api-go/internal/config"
	"thonnas/api-go/internal/thonnas/contracts"
)

// NewBundle resolves metrics/logger/email/events contracts using registered wiring hooks or noops.
//
// @intent Bootstrap entry matching Nest ThonnasContractsModule aggregate
func NewBundle(cfg *config.Config, log *logger.Logger) (*Bundle, error) {
	mc := thonnasmetrics.LoadMetricsConfig(
		cfg.Metricsenabled(),
		cfg.Metricsprovider(),
		cfg.Servicename(),
		cfg.Environment(),
		cfg.Otelendpoint(),
	)

	mp, err := thonnasmetrics.ResolveMetricsProvider(log, mc)
	if err != nil {
		return nil, fmt.Errorf("metrics resolve: %w", err)
	}

	var tm contracts.ThonnasMetrics
	if x, ok := mp.(contracts.ThonnasMetrics); ok {
		tm = x
	} else {
		tm = thonnasmetrics.NewNoOpMetricsProvider()
	}

	cc := thonnascache.LoadCacheConfig(cfg)
	cp, err := thonnascache.ResolveCacheProvider(log, cc)
	if err != nil {
		return nil, fmt.Errorf("cache resolve: %w", err)
	}

	var tc contracts.ThonnasCache
	if x, ok := cp.(contracts.ThonnasCache); ok {
		tc = x
	} else {
		tc = thonnascache.NewNoOpCacheProvider()
	}

	workerRegistry := thonnasworker.NewJobRegistry()

	return &Bundle{
		metricsBackend: mp,
		cacheBackend:   cp,
		workerRegistry: workerRegistry,
		ThonnasMetrics: tm,
		ThonnasCache:   tc,
		ThonnasWorker:  workerRegistry,
		ThonnasHealth:  commonhealth.NewRegistry(),
		ThonnasLogger:  thonnaslogger.ResolveThonnasLogger(log),
		ThonnasEmail:   thonnasemail.ResolveThonnasEmail(log),
		ThonnasEvents:  thonnasevents.ResolveThonnasEvents(log),
	}, nil
}

