package metrics

import "time"

// NoOpMetricsProvider is a no-op implementation for testing or when metrics disabled
// Implements MetricsProvider interface but does nothing
type NoOpMetricsProvider struct{}

// NewNoOpMetricsProvider creates a no-op metrics provider
func NewNoOpMetricsProvider() MetricsProvider {
	return &NoOpMetricsProvider{}
}

func (n *NoOpMetricsProvider) IncrementCounter(name string, labels map[string]string) {}
func (n *NoOpMetricsProvider) AddCounter(name string, value float64, labels map[string]string) {}
func (n *NoOpMetricsProvider) SetGauge(name string, value float64, labels map[string]string) {}
func (n *NoOpMetricsProvider) IncrementGauge(name string, labels map[string]string) {}
func (n *NoOpMetricsProvider) DecrementGauge(name string, labels map[string]string) {}
func (n *NoOpMetricsProvider) RecordHistogram(name string, value float64, labels map[string]string) {}
func (n *NoOpMetricsProvider) RecordDuration(name string, duration time.Duration, labels map[string]string) {}
func (n *NoOpMetricsProvider) Close() error { return nil }




