package health

import (
	"fmt"
	"runtime"
	"time"

	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/common/version"
	"thonnas/api-go/internal/thonnas/contracts"

	"github.com/gin-gonic/gin"
)

// HealthHandler handles health check requests
type HealthHandler struct {
	logger         *logger.Logger
	thonnasMetrics contracts.ThonnasMetrics
	thonnasHealth  contracts.ThonnasHealth
	startTime      time.Time
}

// NewHealthHandler creates a new health handler
func NewHealthHandler(log *logger.Logger, thonnasMetrics contracts.ThonnasMetrics, th contracts.ThonnasHealth) *HealthHandler {
	return &HealthHandler{
		logger:         log,
		thonnasMetrics: thonnasMetrics,
		thonnasHealth:  th,
		startTime:      time.Now(),
	}
}

// HandleHealthCheck returns the health status of the service (combined liveness + readiness)
// GET /health
func (h *HealthHandler) HandleHealthCheck(c *gin.Context) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	uptime := time.Since(h.startTime).Seconds()
	versionInfo := version.Get()

	checks, err := h.thonnasHealth.RunAllChecks(c.Request.Context())
	if err != nil {
		h.logger.Error(fmt.Sprintf("health RunAllChecks: %v", err))
		checks = map[string]contracts.HealthCheckSnapshot{}
	}

	response := gin.H{
		"status":      rollupHealth(checks),
		"uptime":      uptime,
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
		"version":     versionInfo.Version,
		"commit":      versionInfo.Commit,
		"build_time":  versionInfo.BuildTime,
		"go_version":  versionInfo.GoVersion,
		"goroutines":  runtime.NumGoroutine(),
		"checks":      checks,
		"memory": gin.H{
			"alloc":       mem.Alloc,
			"total_alloc": mem.TotalAlloc,
			"sys":         mem.Sys,
			"num_gc":      mem.NumGC,
		},
	}

	c.JSON(200, response)
}

func rollupHealth(checks map[string]contracts.HealthCheckSnapshot) string {
	if len(checks) == 0 {
		return "healthy"
	}
	for _, s := range checks {
		if s.Status == contracts.HealthStatusUnhealthy {
			return "error"
		}
	}
	for _, s := range checks {
		if s.Status == contracts.HealthStatusDegraded {
			return "degraded"
		}
	}
	return "healthy"
}

// HandleLiveness returns liveness probe status (Kubernetes liveness probe)
// GET /health/live
func (h *HealthHandler) HandleLiveness(c *gin.Context) {
	c.JSON(200, gin.H{
		"status":    "alive",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

// HandleReadiness returns readiness probe status (Kubernetes readiness probe)
// GET /health/ready
func (h *HealthHandler) HandleReadiness(c *gin.Context) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	isReady := true
	reasons := []string{}

	maxGoroutines := 10000
	if runtime.NumGoroutine() > maxGoroutines {
		isReady = false
		reasons = append(reasons, fmt.Sprintf("goroutine count too high: %d", runtime.NumGoroutine()))
	}

	memUsagePercent := float64(mem.Alloc) / float64(mem.Sys) * 100
	if memUsagePercent > 90 {
		isReady = false
		reasons = append(reasons, fmt.Sprintf("memory usage too high: %.1f%%", memUsagePercent))
	}

	if isReady {
		c.JSON(200, gin.H{
			"status":    "ready",
			"timestamp": time.Now().UTC().Format(time.RFC3339),
			"checks": gin.H{
				"goroutines": gin.H{
					"status": "ok",
					"count":  runtime.NumGoroutine(),
				},
				"memory": gin.H{
					"status":        "ok",
					"usage_percent": memUsagePercent,
				},
			},
		})
	} else {
		c.JSON(503, gin.H{
			"status":    "not_ready",
			"reasons":   reasons,
			"timestamp": time.Now().UTC().Format(time.RFC3339),
		})
	}
}

