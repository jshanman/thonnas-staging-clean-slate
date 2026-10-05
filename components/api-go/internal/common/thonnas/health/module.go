package health

import (
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/thonnas/contracts"

	"github.com/gin-gonic/gin"
)

// HealthModule encapsulates the health check feature (inlined common/thonnas, not a tm-* extract).
type HealthModule struct {
	handler *HealthHandler
}

// BuildModule provides a standardized builder (no MQTT subscriptions to stage)
func BuildModule(log *logger.Logger, thonnasMetrics contracts.ThonnasMetrics, th contracts.ThonnasHealth) *HealthModule {
	return NewHealthModule(log, thonnasMetrics, th)
}

// NewHealthModule creates and wires up the health module
func NewHealthModule(log *logger.Logger, thonnasMetrics contracts.ThonnasMetrics, th contracts.ThonnasHealth) *HealthModule {
	handler := NewHealthHandler(log, thonnasMetrics, th)

	return &HealthModule{
		handler: handler,
	}
}

// RegisterRoutes registers all routes for this module
func (m *HealthModule) RegisterRoutes(router *gin.Engine) {
	router.GET("/health", m.handler.HandleHealthCheck)
	router.GET("/health/live", m.handler.HandleLiveness)
	router.GET("/health/ready", m.handler.HandleReadiness)
}

