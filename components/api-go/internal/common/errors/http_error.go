package errors

import (
	"time"
	
	"github.com/gin-gonic/gin"
)

// HTTPError represents a structured HTTP error response
// Provides consistent error format across all endpoints
type HTTPError struct {
	Status        int         `json:"status"`           // HTTP status code
	Error         string      `json:"error"`            // Error type/code
	Message       string      `json:"message"`          // Human-readable message
	CorrelationID string      `json:"correlationId,omitempty"` // Request trace ID
	Timestamp     string      `json:"timestamp"`        // ISO 8601 timestamp
	Details       interface{} `json:"details,omitempty"` // Additional error details
}

// NewHTTPError creates a structured HTTP error
func NewHTTPError(status int, errorCode string, message string) *HTTPError {
	return &HTTPError{
		Status:    status,
		Error:     errorCode,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

// WithCorrelationID adds correlation ID to the error
func (e *HTTPError) WithCorrelationID(id string) *HTTPError {
	e.CorrelationID = id
	return e
}

// WithDetails adds additional error details
func (e *HTTPError) WithDetails(details interface{}) *HTTPError {
	e.Details = details
	return e
}

// Send writes the error response to Gin context
func (e *HTTPError) Send(c *gin.Context) {
	c.JSON(e.Status, e)
}

// Common error constructors for consistency

// BadRequest creates a 400 Bad Request error
func BadRequest(message string) *HTTPError {
	return NewHTTPError(400, "bad_request", message)
}

// Unauthorized creates a 401 Unauthorized error
func Unauthorized(message string) *HTTPError {
	return NewHTTPError(401, "unauthorized", message)
}

// Forbidden creates a 403 Forbidden error
func Forbidden(message string) *HTTPError {
	return NewHTTPError(403, "forbidden", message)
}

// NotFound creates a 404 Not Found error
func NotFound(message string) *HTTPError {
	return NewHTTPError(404, "not_found", message)
}

// InternalServerError creates a 500 Internal Server Error
func InternalServerError(message string) *HTTPError {
	return NewHTTPError(500, "internal_server_error", message)
}

// SendError is a helper to send structured errors from any handler
// Automatically includes correlation ID from Gin context
func SendError(c *gin.Context, status int, errorCode string, message string) {
	// Get correlation ID from context
	correlationID := ""
	if id, exists := c.Get("correlationId"); exists {
		if idStr, ok := id.(string); ok {
			correlationID = idStr
		}
	}
	
	err := NewHTTPError(status, errorCode, message).WithCorrelationID(correlationID)
	err.Send(c)
}




