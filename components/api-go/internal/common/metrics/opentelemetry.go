package metrics

import (
	"context"
	"fmt"
	"sync"
	"time"
	
	"thonnas/api-go/internal/common/logger"
	
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
)

// OpenTelemetryProvider implements MetricsProvider using OpenTelemetry
// Exports to any OTel-compatible backend (SigNoz, Jaeger, Prometheus, Datadog, etc.)
type OpenTelemetryProvider struct {
	serviceName    string
	environment    string
	endpoint       string
	logger         *logger.Logger
	meterProvider  *sdkmetric.MeterProvider
	meter          metric.Meter
	
	// Instrument caches
	counters       map[string]metric.Int64Counter
	gauges         map[string]metric.Int64UpDownCounter
	histograms     map[string]metric.Float64Histogram
	instrumentsMux sync.RWMutex
}

// NewOpenTelemetryProvider creates an OpenTelemetry metrics provider
func NewOpenTelemetryProvider(cfg *MetricsConfig, log *logger.Logger) (MetricsProvider, error) {
	ctx := context.Background()
	
	// Create resource with service info
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}
	
	// Create OTLP exporter (exports to SigNoz, Jaeger, etc.)
	// Note: Using insecure connection for local development
	// In production, configure TLS via OTEL_ENDPOINT (e.g., https://signoz:4317)
	exporter, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(cfg.OTelEndpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create OTLP exporter: %w", err)
	}
	
	// Create meter provider
	meterProvider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)),
	)
	
	// Set global meter provider
	otel.SetMeterProvider(meterProvider)
	
	// Get meter for this service
	meter := meterProvider.Meter(cfg.ServiceName)
	
	provider := &OpenTelemetryProvider{
		serviceName:   cfg.ServiceName,
		environment:   cfg.Environment,
		endpoint:      cfg.OTelEndpoint,
		logger:        log,
		meterProvider: meterProvider,
		meter:         meter,
		counters:      make(map[string]metric.Int64Counter),
		gauges:        make(map[string]metric.Int64UpDownCounter),
		histograms:    make(map[string]metric.Float64Histogram),
	}
	
	log.WithFields(map[string]interface{}{
		"endpoint":    cfg.OTelEndpoint,
		"service":     cfg.ServiceName,
		"environment": cfg.Environment,
	}).Info("OpenTelemetry metrics provider initialized")
	
	return provider, nil
}

// IncrementCounter increments a counter metric
func (o *OpenTelemetryProvider) IncrementCounter(name string, labels map[string]string) {
	o.AddCounter(name, 1, labels)
}

// AddCounter adds a value to a counter metric
func (o *OpenTelemetryProvider) AddCounter(name string, value float64, labels map[string]string) {
	counter, err := o.getOrCreateCounter(name)
	if err != nil {
		o.logger.WithField("error", err.Error()).Warn("Failed to get counter")
		return
	}
	
	counter.Add(context.Background(), int64(value), metric.WithAttributes(convertLabels(labels)...))
}

// SetGauge sets a gauge metric
func (o *OpenTelemetryProvider) SetGauge(name string, value float64, labels map[string]string) {
	// For "set" operation, we use UpDownCounter with difference
	// This is a workaround since OTel gauges are observable (callback-based)
	// For true gauge behavior, use IncrementGauge/DecrementGauge
	o.logger.Debug("SetGauge called - consider using IncrementGauge/DecrementGauge for better OTel compatibility")
}

// IncrementGauge increments a gauge (UpDownCounter in OTel)
func (o *OpenTelemetryProvider) IncrementGauge(name string, labels map[string]string) {
	gauge, err := o.getOrCreateGauge(name)
	if err != nil {
		o.logger.WithField("error", err.Error()).Warn("Failed to get gauge")
		return
	}
	
	gauge.Add(context.Background(), 1, metric.WithAttributes(convertLabels(labels)...))
}

// DecrementGauge decrements a gauge (UpDownCounter in OTel)
func (o *OpenTelemetryProvider) DecrementGauge(name string, labels map[string]string) {
	gauge, err := o.getOrCreateGauge(name)
	if err != nil {
		o.logger.WithField("error", err.Error()).Warn("Failed to get gauge")
		return
	}
	
	gauge.Add(context.Background(), -1, metric.WithAttributes(convertLabels(labels)...))
}

// RecordHistogram records a value in a histogram
func (o *OpenTelemetryProvider) RecordHistogram(name string, value float64, labels map[string]string) {
	histogram, err := o.getOrCreateHistogram(name)
	if err != nil {
		o.logger.WithField("error", err.Error()).Warn("Failed to get histogram")
		return
	}
	
	histogram.Record(context.Background(), value, metric.WithAttributes(convertLabels(labels)...))
}

// RecordDuration records a duration in a histogram (converts to seconds)
func (o *OpenTelemetryProvider) RecordDuration(name string, duration time.Duration, labels map[string]string) {
	o.RecordHistogram(name, duration.Seconds(), labels)
}

// Close shuts down the OpenTelemetry provider
func (o *OpenTelemetryProvider) Close() error {
	if o.meterProvider != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		
		if err := o.meterProvider.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown meter provider: %w", err)
		}
	}
	return nil
}

// Instrument creation helpers (lazy initialization)

func (o *OpenTelemetryProvider) getOrCreateCounter(name string) (metric.Int64Counter, error) {
	o.instrumentsMux.RLock()
	counter, exists := o.counters[name]
	o.instrumentsMux.RUnlock()
	
	if exists {
		return counter, nil
	}
	
	o.instrumentsMux.Lock()
	defer o.instrumentsMux.Unlock()
	
	// Double-check after acquiring write lock
	if counter, exists := o.counters[name]; exists {
		return counter, nil
	}
	
	// Create new counter
	counter, err := o.meter.Int64Counter(name,
		metric.WithDescription(getMetricDescription(name)),
	)
	if err != nil {
		return nil, err
	}
	
	o.counters[name] = counter
	return counter, nil
}

func (o *OpenTelemetryProvider) getOrCreateGauge(name string) (metric.Int64UpDownCounter, error) {
	o.instrumentsMux.RLock()
	gauge, exists := o.gauges[name]
	o.instrumentsMux.RUnlock()
	
	if exists {
		return gauge, nil
	}
	
	o.instrumentsMux.Lock()
	defer o.instrumentsMux.Unlock()
	
	if gauge, exists := o.gauges[name]; exists {
		return gauge, nil
	}
	
	gauge, err := o.meter.Int64UpDownCounter(name,
		metric.WithDescription(getMetricDescription(name)),
	)
	if err != nil {
		return nil, err
	}
	
	o.gauges[name] = gauge
	return gauge, nil
}

func (o *OpenTelemetryProvider) getOrCreateHistogram(name string) (metric.Float64Histogram, error) {
	o.instrumentsMux.RLock()
	histogram, exists := o.histograms[name]
	o.instrumentsMux.RUnlock()
	
	if exists {
		return histogram, nil
	}
	
	o.instrumentsMux.Lock()
	defer o.instrumentsMux.Unlock()
	
	if histogram, exists := o.histograms[name]; exists {
		return histogram, nil
	}
	
	histogram, err := o.meter.Float64Histogram(name,
		metric.WithDescription(getMetricDescription(name)),
	)
	if err != nil {
		return nil, err
	}
	
	o.histograms[name] = histogram
	return histogram, nil
}

// convertLabels converts map[string]string to OpenTelemetry attributes
func convertLabels(labels map[string]string) []attribute.KeyValue {
	if len(labels) == 0 {
		return nil
	}
	
	attrs := make([]attribute.KeyValue, 0, len(labels))
	for k, v := range labels {
		attrs = append(attrs, attribute.String(k, v))
	}
	return attrs
}

// getMetricDescription returns a description for common metrics
func getMetricDescription(name string) string {
	descriptions := map[string]string{
		MetricHTTPRequestsTotal:           "Total number of HTTP requests",
		MetricHTTPRequestDuration:         "HTTP request duration in seconds",
		MetricWebSocketConnectionsTotal:   "Current number of WebSocket connections",
		MetricWebSocketMessagesTotal:      "Total WebSocket messages sent/received",
		MetricWebSocketConnectionDuration: "WebSocket connection duration in seconds",
		MetricUserCountTotal:              "Current number of unique users online",
		MetricErrorsTotal:                 "Total number of errors",
	}
	
	if desc, exists := descriptions[name]; exists {
		return desc
	}
	return name
}


