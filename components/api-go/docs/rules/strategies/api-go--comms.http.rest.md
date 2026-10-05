# Strategy Implementation: comms.http.rest

**Component/Module:** api-go  
**Strategy:** `comms.http.rest`  
**Category:** comms.http  
**Purpose:** HTTP REST communication

---

## Implementation Approach

### Overview

api-go follows RESTful conventions with Gin framework: resource-based URLs, standard HTTP methods, appropriate status codes, and consistent error responses matching NestJS format for frontend compatibility.

### Technology Stack

- **HTTP Framework:** `github.com/gin-gonic/gin` - Idiomatic Go HTTP router
- **Status Codes:** Standard HTTP codes (200, 201, 400, 401, 404, 500)
- **Error Format:** Consistent with NestJS (statusCode, error, message, timestamp)
- **Content-Type:** `application/json` for all requests/responses

### Key Components

- **Health Handlers** - `/health`, `/health/live`, `/health/ready` endpoints
- **Error Package** - Standardized error responses
- **Gin Context** - Request/response handling with JSON auto-binding
- **HTTP Methods** - GET (read), POST (create), PATCH (update), DELETE (delete)

---

## Code Patterns

### Basic Usage

```go
// Resource-based URLs with standard HTTP methods
router.GET("/api/users/:id", getUserHandler)      // Read
router.POST("/api/users", createUserHandler)       // Create
router.PATCH("/api/users/:id", updateUserHandler)  // Partial update
router.DELETE("/api/users/:id", deleteUserHandler) // Delete

// Handler with status code and JSON response
func getUserHandler(c *gin.Context) {
    userID := c.Param("id")
    user, err := fetchUser(userID)
    if err != nil {
        errors.SendError(c, 404, "user_not_found", "User not found")
        return
    }
    c.JSON(200, user)  // OK
}
```

### Advanced Patterns

**Standardized Error Responses:**
```go
// All errors use consistent format (matches NestJS)
errors.SendError(c, 400, "validation_error", "Invalid email format")

// Response:
{
    "statusCode": 400,
    "error": "validation_error",
    "message": "Invalid email format",
    "timestamp": "2024-01-15T10:30:00Z"
}
```

**Request Binding with Validation:**
```go
type CreateUserRequest struct {
    Email    string `json:"email" binding:"required,email"`
    Password string `json:"password" binding:"required,min=8"`
}

func createUserHandler(c *gin.Context) {
    var req CreateUserRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        errors.SendError(c, 400, "validation_error", err.Error())
        return
    }
    // Process request...
    c.JSON(201, user)  // Created
}
```

---

## Configuration

### Required Settings

- `PORT` - HTTP server port
- `CORS_ALLOWED_ORIGINS` - Allowed origins for CORS
- `GIN_MODE` - debug or release mode

### Environment Variables

```bash
PORT=3001
GIN_MODE=release
CORS_ALLOWED_ORIGINS=http://localhost:4200
HTTP_READ_TIMEOUT=15s
HTTP_WRITE_TIMEOUT=15s
```

---

## Best Practices

- ✅ **Resource-based URLs** - `/api/users`, `/api/orders` (nouns, not verbs)
- ✅ **Standard HTTP methods** - GET, POST, PATCH, DELETE for CRUD operations
- ✅ **Appropriate status codes** - 200 (OK), 201 (Created), 400 (Bad Request), 404 (Not Found)
- ✅ **Consistent error format** - Match NestJS format for frontend compatibility
- ✅ **Plural resource names** - `/users` not `/user`

---

## Common Pitfalls

### ❌ Pitfall: Verb-based URLs

**Wrong:**
```go
router.POST("/api/createUser", handler)      // Verb in URL
router.GET("/api/getUser/:id", handler)
```

**Correct:**
```go
router.POST("/api/users", createUserHandler)    // Noun + HTTP method
router.GET("/api/users/:id", getUserHandler)
```

---

## Testing Strategy

### Unit Tests

```go
func TestGetUser_Success(t *testing.T) {
    router := gin.New()
    router.GET("/users/:id", getUserHandler)
    
    req := httptest.NewRequest("GET", "/users/123", nil)
    w := httptest.NewRecorder()
    router.ServeHTTP(w, req)
    
    assert.Equal(t, 200, w.Code)
}
```

### Integration Tests

- **HTTP method correctness** - GET for read, POST for create, PATCH for update
- **Status code accuracy** - 200/201 for success, 400 for validation, 404 for not found
- **Error format consistency** - All errors follow NestJS format
- **CORS headers** - Preflight and actual requests handled correctly

---

## Security Considerations

- ✅ **Input validation** - Validate all request bodies
- ✅ **Authentication** - JWT middleware on protected endpoints
- ✅ **CORS configuration** - Explicit allowed origins list
- ✅ **Rate limiting** - Prevent API abuse

---

## Performance Optimization

- **Gin performance** - One of fastest Go frameworks
- **JSON auto-binding** - Efficient request parsing
- **Connection pooling** - Reuse HTTP connections
- **Timeout configuration** - Prevent resource exhaustion

---

## Related Strategies

- [`comms.http.rest`](api-go--comms.http.rest.md) - Full REST API implementation
- [`auth.jwt`](api-go--auth.jwt.md) - JWT authentication for protected endpoints

---

## See Also

- [api-go.md](../api-go.md) - Full component/module documentation

---

*This is a template. Please update with specific implementation details.*

