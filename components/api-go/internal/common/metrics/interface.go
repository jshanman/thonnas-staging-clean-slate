package metrics

import "time"

// MetricsProvider defines the interface for metrics collection
// This abstraction allows swapping implementations (Prometheus, OpenTelemetry, Datadog, etc.)
// without changing application code
type MetricsProvider interface {
	// Counter metrics (monotonically increasing)
	IncrementCounter(name string, labels map[string]string)
	AddCounter(name string, value float64, labels map[string]string)
	
	// Gauge metrics (can go up or down)
	SetGauge(name string, value float64, labels map[string]string)
	IncrementGauge(name string, labels map[string]string)
	DecrementGauge(name string, labels map[string]string)
	
	// Histogram metrics (distribution of values)
	RecordHistogram(name string, value float64, labels map[string]string)
	
	// Timing helper (convenience for duration histograms)
	RecordDuration(name string, duration time.Duration, labels map[string]string)
	
	// Lifecycle
	Close() error
}

// MetricsConfig holds configuration for metrics provider
type MetricsConfig struct {
	Provider    string // "opentelemetry" (SigNoz), "noop" (disabled)
	Enabled     bool
	ServiceName string
	Environment string
	
	// OpenTelemetry configuration
	OTelEndpoint    string // OpenTelemetry collector endpoint (e.g., "signoz:4317")
}

// Common metric names (constants for consistency)
const (
	// HTTP metrics
	MetricHTTPRequestsTotal    = "http_requests_total"
	MetricHTTPRequestDuration  = "http_request_duration_seconds"
	MetricHTTPResponseSize     = "http_response_size_bytes"
	
	// WebSocket metrics
	MetricWebSocketConnectionsTotal    = "websocket_connections_total"
	MetricWebSocketConnectionDuration  = "websocket_connection_duration_seconds"
	MetricWebSocketMessagesTotal       = "websocket_messages_total"
	MetricWebSocketMessageSize         = "websocket_message_size_bytes"
	MetricWebSocketBroadcastDuration   = "websocket_broadcast_duration_seconds"
	
	// User count metrics
	MetricUserCountTotal = "user_count_total"
	
	// Error metrics
	MetricErrorsTotal = "errors_total"
	
	// Job Runner metrics
	MetricJobRunnerWorkflowStarted   = "jobrunner_workflow_started_total"
	MetricJobRunnerWorkflowCompleted = "jobrunner_workflow_completed_total"
	MetricJobRunnerWorkflowFailed    = "jobrunner_workflow_failed_total"
	MetricJobRunnerWorkflowDuration  = "jobrunner_workflow_duration_seconds"
	MetricJobRunnerActivityStarted   = "jobrunner_activity_started_total"
	MetricJobRunnerActivityCompleted = "jobrunner_activity_completed_total"
	MetricJobRunnerActivityFailed    = "jobrunner_activity_failed_total"
	MetricJobRunnerActivityDuration  = "jobrunner_activity_duration_seconds"
)

// Common label names
const (
	LabelMethod      = "method"
	LabelPath        = "path"
	LabelStatus      = "status"
	LabelError       = "error"
	LabelUserID      = "user_id"
	LabelMessageType = "message_type"
	LabelDirection   = "direction" // "sent" or "received"
	LabelJobName     = "job_name"
	LabelActivity    = "activity"
	LabelWorkflow    = "workflow"
)


