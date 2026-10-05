package thonnasmetrics

import "time"

// MetricsProvider is the extended backend used only inside common/thonnas wiring and optional OTLP installers.
// Application modules must depend on contracts.ThonnasMetrics (via ctx.Contracts.ThonnasMetrics), not this type.
//
// @intent Portable metrics backend surface — never inject into feature modules directly
type MetricsProvider interface {
	IncrementCounter(name string, labels map[string]string)
	AddCounter(name string, value float64, labels map[string]string)
	SetGauge(name string, value float64, labels map[string]string)
	IncrementGauge(name string, labels map[string]string)
	DecrementGauge(name string, labels map[string]string)
	RecordHistogram(name string, value float64, labels map[string]string)
	RecordDuration(name string, duration time.Duration, labels map[string]string)
	Close() error
}

// MetricsConfig holds configuration for metrics provider wiring.
type MetricsConfig struct {
	Provider     string
	Enabled      bool
	ServiceName  string
	Environment  string
	OTelEndpoint string
}

// LoadMetricsConfig maps application config into MetricsConfig.
func LoadMetricsConfig(enabled bool, provider, serviceName, environment, otelEndpoint string) *MetricsConfig {
	return &MetricsConfig{
		Provider:     provider,
		Enabled:      enabled,
		ServiceName:  serviceName,
		Environment:  environment,
		OTelEndpoint: otelEndpoint,
	}
}

