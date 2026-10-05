# Strategy Implementation: observe.logging.structured

**Component/Module:** api-go  
**Strategy:** `observe.logging.structured`  
**Category:** observe.logging  
**Purpose:** Structured logging

---

## Implementation Approach

### Overview

api-go uses Logrus for structured logging with JSON format, correlation IDs, request/response logging, and OpenTelemetry trace integration. Supports both JSON (production) and text (development) formats.

### Technology Stack

- **Logging Library:** `github.com/sirupsen/logrus` - Structured logging for Go
- **Format:** JSON (production) or Text (development)
- **Fields:** Key-value pairs for structured data (correlation_id, user_id, trace_id, span_id)
- **Levels:** Debug, Info, Warn, Error with configurable threshold

### Key Components

- **Logger** (`internal/common/logger/logger.go`) - Wrapper around logrus with convenience methods
- **Logger Middleware** (`internal/middleware/logger.go`) - Request/response logging
- **WithFields** - Contextual logging with additional fields
- **WithRequestContext** - Correlation ID, user ID, trace ID propagation

---

## Code Patterns

### Basic Usage

```go
// Create logger with level and format
logger := logger.New("info", "json")

// Log messages at different levels
logger.Info("Server starting")
logger.Warn("High memory usage detected")
logger.Error("Database connection failed")
logger.Debug("Processing request payload")
```

### Advanced Patterns

**Contextual Logging with Fields:**
```go
// Add structured fields to log entry
logger.WithFields(map[string]interface{}{
    "userId": "user-123",
    "orderId": "order-456",
    "amount": 99.99,
}).Info("Order created successfully")

// Output (JSON):
{
    "timestamp": "2024-01-15T10:30:00Z",
    "level": "info",
    "message": "Order created successfully",
    "userId": "user-123",
    "orderId": "order-456",
    "amount": 99.99
}
```

**Request Logging with Correlation:**
```go
// Middleware adds correlation ID to all logs
func LoggerMiddleware(log *logger.Logger) gin.HandlerFunc {
    return func(c *gin.Context) {
        correlationID := c.GetHeader("X-Correlation-ID")
        if correlationID == "" {
            correlationID = uuid.New().String()
        }
        
        log.WithFields(map[string]interface{}{
            "correlation_id": correlationID,
            "method": c.Request.Method,
            "path": c.Request.URL.Path,
        }).Info("Request received")
        
        c.Next()
    }
}
```

---

## Configuration

### Required Settings

- `LOG_LEVEL` - Logging threshold: debug, info, warn, error (default: info)
- `LOG_FORMAT` - Output format: json or text (default: json)

### Environment Variables

```bash
LOG_LEVEL=info          # debug, info, warn, error
LOG_FORMAT=json         # json (production), text (development)
```

---

## Best Practices

- ✅ **JSON in production** - Structured logs for log aggregation tools
- ✅ **Correlation IDs** - Track requests across services and logs
- ✅ **Contextual fields** - Add relevant context (userId, orderId, etc.)
- ✅ **Appropriate levels** - Debug for dev, Info for normal, Warn/Error for issues
- ✅ **Don't log secrets** - Never log passwords, JWT tokens, API keys

---

## Common Pitfalls

### ❌ Pitfall: Logging sensitive data

**Wrong:**
```go
logger.WithFields(map[string]interface{}{
    "password": userPassword,  // NEVER log secrets!
    "jwt_token": authToken,
}).Info("User login")
```

**Correct:**
```go
logger.WithFields(map[string]interface{}{
    "userId": user.ID,
    "email": user.Email,  // Safe to log
}).Info("User login successful")
```

---

## Testing Strategy

### Unit Tests

```go
func TestLogger_WithFields(t *testing.T) {
    logger := logger.New("info", "json")
    entry := logger.WithFields(map[string]interface{}{
        "key": "value",
    })
    assert.NotNil(t, entry)
}
```

### Integration Tests

- **Log level filtering** - Debug logs hidden at info level
- **JSON format** - Valid JSON output with all required fields
- **Correlation ID propagation** - IDs tracked across middleware and handlers
- **Field marshaling** - Complex types (time.Time, errors) formatted correctly

---

## Security Considerations

- ✅ **No secrets in logs** - Never log passwords, tokens, API keys
- ✅ **PII awareness** - Be careful logging personal information
- ✅ **Log sanitization** - Strip sensitive fields before logging
- ✅ **Log rotation** - Prevent disk fill-up with log rotation

---

## Performance Optimization

- **Structured logging** - More efficient than string concatenation
- **Level checking** - Debug logs skipped at higher levels (no overhead)
- **Async writing** - Logrus writes asynchronously
- **Field reuse** - WithFields creates reusable logger instance

---

## Related Strategies

- [`observe.metrics.prometheus`](api-go--observe.metrics.prometheus.md) - Metrics complement logs
- [`observe.tracing`] - OpenTelemetry trace ID integration

---

## See Also

- [api-go.md](../api-go.md) - Full component/module documentation

---

*This is a template. Please update with specific implementation details.*

