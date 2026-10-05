package thonnasmetrics

import (
	"time"

	"thonnas/api-go/internal/thonnas/contracts"
)

// NoOpMetricsProvider implements MetricsProvider and contracts.ThonnasMetrics with no-op behavior.
type NoOpMetricsProvider struct{}

var _ contracts.ThonnasMetrics = (*NoOpMetricsProvider)(nil)

// NewNoOpMetricsProvider creates a no-op metrics provider (concrete type implements MetricsProvider and contracts.ThonnasMetrics).
func NewNoOpMetricsProvider() *NoOpMetricsProvider {
	return &NoOpMetricsProvider{}
}

func (n *NoOpMetricsProvider) IncrementCounter(name string, labels map[string]string) {}
func (n *NoOpMetricsProvider) AddCounter(name string, value float64, labels map[string]string) {
}
func (n *NoOpMetricsProvider) SetGauge(name string, value float64, labels map[string]string) {}
func (n *NoOpMetricsProvider) IncrementGauge(name string, labels map[string]string)           {}
func (n *NoOpMetricsProvider) DecrementGauge(name string, labels map[string]string)           {}
func (n *NoOpMetricsProvider) RecordHistogram(name string, value float64, labels map[string]string) {
}
func (n *NoOpMetricsProvider) RecordDuration(name string, duration time.Duration, labels map[string]string) {
}

// RecordCounter implements contracts.ThonnasMetrics.
func (n *NoOpMetricsProvider) RecordCounter(name string, value float64, attributes contracts.ThonnasAttributes) {
}

// AddEvent implements contracts.ThonnasMetrics.
func (n *NoOpMetricsProvider) AddEvent(name string, attributes contracts.ThonnasAttributes) {}

func (n *NoOpMetricsProvider) Close() error { return nil }

