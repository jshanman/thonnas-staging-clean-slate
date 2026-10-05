package middleware

import (
	"regexp"
	"time"
	
	"thonnas/api-go/internal/common/errors"
	"thonnas/api-go/internal/common/logger"
	
	"github.com/gin-gonic/gin"
)

// tokenRedactionRegex is used to sanitize JWT tokens from logs
var tokenRedactionRegex = regexp.MustCompile(`(token=)[^&\s]+`)

// LoggerMiddleware logs HTTP requests
// Similar to NestJS request logging interceptor
// Note: Sanitizes JWT tokens from WebSocket query params to prevent credential leakage
func LoggerMiddleware(log *logger.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Start timer
		start := time.Now()
		path := c.Request.URL.Path
		method := c.Request.Method
		
		// Process request
		c.Next()
		
		// Log after request
		latency := time.Since(start)
		statusCode := c.Writer.Status()
		clientIP := c.ClientIP()
		
		// Sanitize query params if this is a WebSocket connection
		// WebSocket endpoint receives JWT token in query param (browser API limitation)
		// We must redact it from logs to prevent credential leakage
		queryString := c.Request.URL.RawQuery
		if path == "/ws" && queryString != "" {
			// Replace token value with redacted placeholder
			queryString = tokenRedactionRegex.ReplaceAllString(queryString, "$1***REDACTED***")
		}
		
		// Get correlation ID from context
		correlationID := GetCorrelationID(c)
		
		log.WithFields(map[string]interface{}{
			"correlation_id": correlationID,  // Request tracing
			"method":         method,
			"path":           path,
			"query":          queryString,  // Sanitized for /ws endpoint
			"status":         statusCode,
			"latency_ms":     latency.Milliseconds(),
			"client_ip":      clientIP,
			"user_agent":     c.Request.UserAgent(),
		}).Info("HTTP request")
	}
}

// RecoveryMiddleware recovers from panics and logs the error
// Similar to NestJS exception filters
// Returns structured error responses
func RecoveryMiddleware(log *logger.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if err := recover(); err != nil {
				// Get correlation ID for tracing
				correlationID := GetCorrelationID(c)
				
				log.WithFields(map[string]interface{}{
					"error":          err,
					"path":           c.Request.URL.Path,
					"method":         c.Request.Method,
					"correlation_id": correlationID,
				}).Error("Panic recovered in HTTP handler")
				
				// Send structured error response
				errors.SendError(c, 500, "internal_server_error", "An unexpected error occurred")
				c.Abort()
			}
		}()
		c.Next()
	}
}


