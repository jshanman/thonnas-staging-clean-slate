package middleware

import (
	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "api-go"

// TracingMiddleware adds OpenTelemetry tracing to HTTP requests
// Creates a span for each request and propagates trace context
func TracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer(tracerName)
	
	return func(c *gin.Context) {
		// Extract trace context from incoming request headers (if present)
		// This allows distributed tracing across multiple services
		ctx := otel.GetTextMapPropagator().Extract(
			c.Request.Context(),
			propagation.HeaderCarrier(c.Request.Header),
		)
		
		// Start a new span for this request
		spanName := c.Request.Method + " " + c.FullPath()
		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.method", c.Request.Method),
				attribute.String("http.target", c.Request.URL.Path),
				attribute.String("http.scheme", c.Request.URL.Scheme),
				attribute.String("http.host", c.Request.Host),
				attribute.String("http.user_agent", c.Request.UserAgent()),
				attribute.String("http.client_ip", c.ClientIP()),
			),
		)
		defer span.End()
		
		// Store context in Gin context for use in handlers
		c.Request = c.Request.WithContext(ctx)
		
		// Add correlation ID to span if present
		if correlationID := GetCorrelationID(c); correlationID != "" {
			span.SetAttributes(attribute.String("correlation.id", correlationID))
		}
		
		// Process request
		c.Next()
		
		// Add response status to span
		statusCode := c.Writer.Status()
		span.SetAttributes(attribute.Int("http.status_code", statusCode))
		
		// Set span status based on HTTP status
		if statusCode >= 400 {
			span.SetStatus(codes.Error, "HTTP error")
		} else {
			span.SetStatus(codes.Ok, "")
		}
	}
}




