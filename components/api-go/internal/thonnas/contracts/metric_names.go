package contracts

// Standard metric and label names (portable; same strings as OTEL/Prometheus export).
// Feature modules should import only this package for names, not vendor metrics packages.
//
// @intent Keep module code strategy-agnostic — wiring maps these to SigNoz/OTEL instruments
const (
	MetricHTTPRequestsTotal          = "http_requests_total"
	MetricHTTPRequestDuration        = "http_request_duration_seconds"
	MetricHTTPResponseSize           = "http_response_size_bytes"
	MetricWebSocketConnectionsTotal  = "websocket_connections_total"
	// MetricWebSocketConnectionsActive is an absolute pool depth (Thonnas RecordCounter + OTLP gauge mapping).
	MetricWebSocketConnectionsActive = "websocket_connections_active"
	MetricWebSocketConnectionDuration = "websocket_connection_duration_seconds"
	MetricWebSocketMessagesTotal     = "websocket_messages_total"
	MetricWebSocketMessageSize       = "websocket_message_size_bytes"
	MetricWebSocketBroadcastDuration = "websocket_broadcast_duration_seconds"
	MetricUserCountTotal             = "user_count_total"
	MetricErrorsTotal                = "errors_total"
	MetricJobRunnerWorkflowStarted   = "jobrunner_workflow_started_total"
	MetricJobRunnerWorkflowCompleted = "jobrunner_workflow_completed_total"
	MetricJobRunnerWorkflowFailed    = "jobrunner_workflow_failed_total"
	MetricJobRunnerWorkflowDuration  = "jobrunner_workflow_duration_seconds"
	MetricJobRunnerActivityStarted   = "jobrunner_activity_started_total"
	MetricJobRunnerActivityCompleted = "jobrunner_activity_completed_total"
	MetricJobRunnerActivityFailed    = "jobrunner_activity_failed_total"
	MetricJobRunnerActivityDuration  = "jobrunner_activity_duration_seconds"
)

// Standard label keys for ThonnasAttributes / metric dimensions.
const (
	LabelMethod      = "method"
	LabelPath        = "path"
	LabelStatus      = "status"
	LabelError       = "error"
	LabelUserID      = "user_id"
	LabelMessageType = "message_type"
	LabelDirection   = "direction"
	LabelJobName     = "job_name"
	LabelActivity    = "activity"
	LabelWorkflow    = "workflow"
)

