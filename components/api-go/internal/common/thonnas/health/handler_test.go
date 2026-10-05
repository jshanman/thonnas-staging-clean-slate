package health

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"thonnas/api-go/internal/common/logger"
	thonnasmetrics "thonnas/api-go/internal/common/thonnas/metrics"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestHandler() (*HealthHandler, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()
	handler := NewHealthHandler(log, metricsProvider, reg)
	router := gin.New()
	return handler, router
}

func TestNewHealthHandler(t *testing.T) {
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	handler := NewHealthHandler(log, metricsProvider, reg)

	assert.NotNil(t, handler)
	assert.NotNil(t, handler.logger)
	assert.NotNil(t, handler.thonnasMetrics)
	assert.False(t, handler.startTime.IsZero())
}

func TestHandleHealthCheck(t *testing.T) {
	handler, router := setupTestHandler()
	router.GET("/health", handler.HandleHealthCheck)

	req, _ := http.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)

	assert.Equal(t, "healthy", response["status"])
	assert.NotNil(t, response["uptime"])
	assert.NotNil(t, response["timestamp"])
	assert.NotNil(t, response["version"])
	assert.NotNil(t, response["commit"])
	assert.NotNil(t, response["build_time"])
	assert.NotNil(t, response["go_version"])
	assert.NotNil(t, response["goroutines"])
	assert.NotNil(t, response["memory"])

	uptime, ok := response["uptime"].(float64)
	assert.True(t, ok, "uptime should be a number")
	assert.GreaterOrEqual(t, uptime, 0.0, "uptime should be non-negative")

	memory, ok := response["memory"].(map[string]interface{})
	assert.True(t, ok, "memory should be an object")
	assert.NotNil(t, memory["alloc"])
	assert.NotNil(t, memory["total_alloc"])
	assert.NotNil(t, memory["sys"])
	assert.NotNil(t, memory["num_gc"])
}

func TestHandleLiveness(t *testing.T) {
	handler, router := setupTestHandler()
	router.GET("/health/live", handler.HandleLiveness)

	req, _ := http.NewRequest("GET", "/health/live", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)

	assert.Equal(t, "alive", response["status"])
	assert.NotNil(t, response["timestamp"])
}

func TestHandleReadiness_Ready(t *testing.T) {
	handler, router := setupTestHandler()
	router.GET("/health/ready", handler.HandleReadiness)

	req, _ := http.NewRequest("GET", "/health/ready", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &response)
	require.NoError(t, err)

	assert.Equal(t, "ready", response["status"])
	assert.NotNil(t, response["timestamp"])
	assert.NotNil(t, response["checks"])

	checks, ok := response["checks"].(map[string]interface{})
	assert.True(t, ok, "checks should be an object")

	goroutinesCheck, ok := checks["goroutines"].(map[string]interface{})
	assert.True(t, ok, "goroutines check should exist")
	assert.Equal(t, "ok", goroutinesCheck["status"])
	assert.NotNil(t, goroutinesCheck["count"])

	memoryCheck, ok := checks["memory"].(map[string]interface{})
	assert.True(t, ok, "memory check should exist")
	assert.Equal(t, "ok", memoryCheck["status"])
	assert.NotNil(t, memoryCheck["usage_percent"])
}

func TestHandleReadiness_MultipleRequests(t *testing.T) {
	handler, router := setupTestHandler()
	router.GET("/health/ready", handler.HandleReadiness)

	for i := 0; i < 5; i++ {
		req, _ := http.NewRequest("GET", "/health/ready", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)

		var response map[string]interface{}
		err := json.Unmarshal(w.Body.Bytes(), &response)
		require.NoError(t, err)

		assert.Equal(t, "ready", response["status"])
	}
}

