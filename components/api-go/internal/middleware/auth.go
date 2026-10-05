package middleware

import (
	"fmt"
	"strings"

	"thonnas/api-go/internal/common/errors"
	"thonnas/api-go/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

// devFallbackJWTSecret is used ONLY in development when no secret is configured
const devFallbackJWTSecret = "dev-jwt-secret-do-not-use-in-production"

// devFallbackInternalAPIKey is used ONLY in development when no key is configured
const devFallbackInternalAPIKey = "dev-internal-api-key"

// GetJWTSecretFromConfig returns the JWT signing secret from the provided config
// Falls back to a development-only default if not set
// Exported for use by other packages (e.g., WebSocket handler)
func GetJWTSecretFromConfig(cfg *config.Config) string {
	if cfg != nil {
		if secret := cfg.Jwtsecret(); secret != "" {
			return secret
		}
	}
	// Development fallback - NEVER use in production
	return devFallbackJWTSecret
}

// GetJWTSecret returns the JWT signing secret by loading config
// Convenience wrapper for packages that don't have config injected
// Exported for use by other packages (e.g., WebSocket handler)
func GetJWTSecret() string {
	cfg, err := config.Load()
	if err == nil && cfg != nil {
		if secret := cfg.Jwtsecret(); secret != "" {
			return secret
		}
	}
	return devFallbackJWTSecret
}

// getInternalAPIKeyFromConfig returns the internal API key from the provided config
// Falls back to a development-only default if not set
func getInternalAPIKeyFromConfig(cfg *config.Config) string {
	if cfg != nil {
		if key := cfg.Internalapikey(); key != "" {
			return key
		}
	}
	// Development fallback - NEVER use in production
	return devFallbackInternalAPIKey
}

// JWTClaims represents the JWT token claims
// Must match the structure used by NestJS API
type JWTClaims struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	jwt.RegisteredClaims
}

// JWTAuthMiddleware validates JWT tokens from Authorization header (REST endpoints only)
// Similar to NestJS @UseGuards(JwtAuthGuard)
//
// IMPORTANT: Use this middleware for REST API endpoints, NOT for WebSocket endpoint (/ws)
// WebSocket authentication uses query parameter due to browser WebSocket API limitation
// (Browser's WebSocket API doesn't support setting custom headers)
//
// Authentication Pattern:
//
//	REST endpoints: Authorization: Bearer <token> (this middleware)
//	WebSocket endpoint: ws://api-go/ws?token=<JWT> (handled in WebSocket handler)
func JWTAuthMiddleware(cfg *config.Config) gin.HandlerFunc {
	// Pre-fetch the secret at middleware creation time for efficiency
	jwtSecret := GetJWTSecretFromConfig(cfg)

	return func(c *gin.Context) {
		// Extract token from Authorization header
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			errors.SendError(c, 401, "missing_authorization", "Authorization header is required")
			c.Abort()
			return
		}

		// Check for Bearer prefix
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || parts[0] != "Bearer" {
			errors.SendError(c, 401, "invalid_authorization_format", "Authorization header must be 'Bearer <token>'")
			c.Abort()
			return
		}

		tokenString := parts[1]

		// Parse and validate token
		token, err := jwt.ParseWithClaims(tokenString, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
			// Verify signing method
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(jwtSecret), nil
		})

		if err != nil {
			errors.SendError(c, 401, "invalid_token", "Invalid or expired JWT token")
			c.Abort()
			return
		}

		// Extract claims
		if claims, ok := token.Claims.(*JWTClaims); ok && token.Valid {
			// Store userId in context for handlers to use
			c.Set("userId", claims.UserID)
			c.Set("email", claims.Email)
			c.Next()
		} else {
			errors.SendError(c, 401, "invalid_token_claims", "Token claims are invalid or expired")
			c.Abort()
			return
		}
	}
}

// ExtractUserIDFromContext retrieves userId from Gin context
// Helper function for handlers to get authenticated user ID
func ExtractUserIDFromContext(c *gin.Context) (string, error) {
	userID, exists := c.Get("userId")
	if !exists {
		return "", fmt.Errorf("userId not found in context")
	}

	userIDStr, ok := userID.(string)
	if !ok {
		return "", fmt.Errorf("userId is not a string")
	}

	return userIDStr, nil
}

// InternalAPIKeyMiddleware validates internal API key for service-to-service calls
// Similar to NestJS internal API guards
func InternalAPIKeyMiddleware(cfg *config.Config) gin.HandlerFunc {
	// Pre-fetch the key at middleware creation time for efficiency
	internalAPIKey := getInternalAPIKeyFromConfig(cfg)

	return func(c *gin.Context) {
		apiKey := c.GetHeader("X-Internal-API-Key")

		if apiKey == "" {
			errors.SendError(c, 401, "missing_api_key", "X-Internal-API-Key header is required for internal endpoints")
			c.Abort()
			return
		}

		if apiKey != internalAPIKey {
			errors.SendError(c, 403, "invalid_api_key", "Invalid internal API key")
			c.Abort()
			return
		}

		c.Next()
	}
}

