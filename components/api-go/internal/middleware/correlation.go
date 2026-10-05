package middleware

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	// CorrelationIDHeader is the HTTP header for correlation/request ID
	CorrelationIDHeader = "X-Correlation-ID"
	
	// CorrelationIDKey is the context key for storing correlation ID
	CorrelationIDKey = "correlationId"
)

// CorrelationIDMiddleware adds correlation ID to requests for distributed tracing
// Similar to NestJS request ID interceptor
// 
// Behavior:
// - If client sends X-Correlation-ID header, use it (preserves trace across services)
// - If not present, generate new UUID
// - Add to response headers
// - Store in Gin context for use in logs/handlers
func CorrelationIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Try to get correlation ID from request header
		correlationID := c.GetHeader(CorrelationIDHeader)
		
		// Generate new UUID if not provided
		if correlationID == "" {
			correlationID = uuid.New().String()
		}
		
		// Store in context for handlers and logging to use
		c.Set(CorrelationIDKey, correlationID)
		
		// Add to response headers (helps with debugging)
		c.Header(CorrelationIDHeader, correlationID)
		
		// Continue processing
		c.Next()
	}
}

// GetCorrelationID retrieves the correlation ID from Gin context
// Helper function for handlers and services
func GetCorrelationID(c *gin.Context) string {
	if correlationID, exists := c.Get(CorrelationIDKey); exists {
		if id, ok := correlationID.(string); ok {
			return id
		}
	}
	return "unknown"
}




