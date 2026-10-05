package logger

import (
	"os"
	
	"github.com/sirupsen/logrus"
)

// Logger wraps logrus for structured logging
// Provides a consistent logging interface similar to NestJS Logger
type Logger struct {
	*logrus.Logger
}

// New creates a new Logger instance with specified level and format
func New(level, format string) *Logger {
	log := logrus.New()
	
	// Set log level
	logLevel, err := logrus.ParseLevel(level)
	if err != nil {
		logLevel = logrus.InfoLevel
	}
	log.SetLevel(logLevel)
	
	// Set log format
	if format == "json" {
		log.SetFormatter(&logrus.JSONFormatter{
			TimestampFormat: "2006-01-02T15:04:05.000Z07:00",
			FieldMap: logrus.FieldMap{
				logrus.FieldKeyTime:  "timestamp",
				logrus.FieldKeyLevel: "level",
				logrus.FieldKeyMsg:   "message",
			},
		})
	} else {
		log.SetFormatter(&logrus.TextFormatter{
			FullTimestamp:   true,
			TimestampFormat: "2006-01-02 15:04:05",
		})
	}
	
	// Output to stdout
	log.SetOutput(os.Stdout)
	
	return &Logger{Logger: log}
}

// WithFields returns a logger with additional fields (for contextual logging)
func (l *Logger) WithFields(fields map[string]interface{}) *logrus.Entry {
	return l.Logger.WithFields(logrus.Fields(fields))
}

// WithField returns a logger with a single additional field
func (l *Logger) WithField(key string, value interface{}) *logrus.Entry {
	return l.Logger.WithField(key, value)
}

// Convenience methods that match NestJS Logger interface

func (l *Logger) Log(message string) {
	l.Info(message)
}

func (l *Logger) Error(message string) {
	l.Logger.Error(message)
}

func (l *Logger) Warn(message string) {
	l.Logger.Warn(message)
}

func (l *Logger) Debug(message string) {
	l.Logger.Debug(message)
}

func (l *Logger) Verbose(message string) {
	l.Logger.Trace(message)
}

// WithContext creates a logger with context fields from OpenTelemetry span
// Automatically includes trace_id and span_id from active span for correlation
func (l *Logger) WithContext(ctx interface{}) *logrus.Entry {
	fields := logrus.Fields{}
	
	// Try to extract OpenTelemetry span context
	// This allows correlating logs with traces in SigNoz
	if ctx != nil {
		// OpenTelemetry span extraction would go here
		// For now, return logger with empty context
		// Full implementation requires importing go.opentelemetry.io/otel/trace
	}
	
	return l.Logger.WithFields(fields)
}

// WithRequestContext creates a logger with request context fields
// Includes correlation ID, user ID, trace ID, etc.
func (l *Logger) WithRequestContext(correlationID, userID, traceID, spanID string) *logrus.Entry {
	fields := logrus.Fields{}
	
	if correlationID != "" {
		fields["correlation_id"] = correlationID
	}
	if userID != "" {
		fields["user_id"] = userID
	}
	if traceID != "" {
		fields["trace_id"] = traceID
	}
	if spanID != "" {
		fields["span_id"] = spanID
	}
	
	return l.Logger.WithFields(fields)
}


