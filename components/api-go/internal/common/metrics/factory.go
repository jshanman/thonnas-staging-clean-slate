package metrics

import (
	"fmt"
	
	"thonnas/api-go/internal/common/logger"
)

// NewMetricsProvider creates the appropriate metrics provider based on configuration
// This factory pattern allows swapping implementations without changing application code
func NewMetricsProvider(cfg *MetricsConfig, log *logger.Logger) (MetricsProvider, error) {
	if !cfg.Enabled {
		log.Info("Metrics disabled, using no-op provider")
		return NewNoOpMetricsProvider(), nil
	}
	
	switch cfg.Provider {
	case "opentelemetry", "otel", "signoz":
		log.WithField("endpoint", cfg.OTelEndpoint).Info("Initializing OpenTelemetry metrics provider")
		return NewOpenTelemetryProvider(cfg, log)
		
	case "noop", "disabled":
		log.Info("Using no-op metrics provider")
		return NewNoOpMetricsProvider(), nil
		
	default:
		return nil, fmt.Errorf("unknown metrics provider: %s (supported: opentelemetry, noop)", cfg.Provider)
	}
}

// Helper function to create MetricsConfig from app Config
func LoadMetricsConfig(enabled bool, provider, serviceName, environment, otelEndpoint string) *MetricsConfig {
	return &MetricsConfig{
		Provider:     provider,
		Enabled:      enabled,
		ServiceName:  serviceName,
		Environment:  environment,
		OTelEndpoint: otelEndpoint,
	}
}


