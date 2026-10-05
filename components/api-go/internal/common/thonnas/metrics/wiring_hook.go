package thonnasmetrics

import "thonnas/api-go/internal/common/logger"

// MetricsProviderBuild is set by vendor *.wiring.* packages or optional metrics installers.
// When nil, ResolveMetricsProvider uses NewNoOpMetricsProvider only (bare component / tests).
//
// @intent Mirror Nest thonnas-metrics.impl.ts IMPL hook — installers register real backends here
var MetricsProviderBuild func(log *logger.Logger, cfg *MetricsConfig) (MetricsProvider, error)

// ResolveMetricsProvider applies MetricsProviderBuild or falls back to noop.
func ResolveMetricsProvider(log *logger.Logger, cfg *MetricsConfig) (MetricsProvider, error) {
	if MetricsProviderBuild != nil {
		return MetricsProviderBuild(log, cfg)
	}
	log.Info("Metrics wiring not registered; using Thonnas metrics noop")
	return NewNoOpMetricsProvider(), nil
}

