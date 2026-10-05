# Strategy Implementation: auth.jwt

**Component/Module:** api-go  
**Strategy:** `auth.jwt`  
**Category:** auth  
**Purpose:** JWT token validation

---

## Implementation Approach

api-go validates HMAC-SHA256 JWTs issued by the companion API component. The
middleware reads `Authorization: Bearer <token>`, verifies the signing method and
secret, then stores user identity values in the Gin context.

## Technology Stack

- **JWT library:** `github.com/golang-jwt/jwt/v5`
- **Signing method:** HMAC-SHA256 (HS256)
- **Secret source:** runtime environment variable via `cfg.Jwtsecret()`
- **Middleware:** `internal/middleware/auth.go`

## Code Pattern

```go
authorized := router.Group("/api")
authorized.Use(middleware.JWTAuthMiddleware(cfg))

authorized.GET("/profile", func(c *gin.Context) {
	userID, err := middleware.ExtractUserIDFromContext(c)
	if err != nil {
		errors.SendError(c, 401, "unauthorized", "Not authenticated")
		return
	}
	c.JSON(200, gin.H{"userId": userID})
})
```

## Configuration

```bash
API_GO_JWT_SECRET=change-this-in-production
```

Secret getters also check `SECRET__API_GO_JWT_SECRET` for generated secret
imports.

## Best Practices

- Validate the JWT signing method before trusting the payload.
- Use strong secrets and inject them at runtime.
- Reject missing, malformed, expired, or incorrectly signed tokens.
- Store only the authenticated identity values needed by handlers.

## Testing

- Valid tokens are accepted.
- Expired tokens are rejected.
- Tokens signed with a different secret are rejected.
- Missing `Authorization` headers return 401.

## Related Strategies

- [`comms.http.rest`](api-go--comms.http.rest.md)


