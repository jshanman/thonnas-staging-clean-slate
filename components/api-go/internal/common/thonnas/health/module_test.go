package health

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"thonnas/api-go/internal/common/logger"
	thonnasmetrics "thonnas/api-go/internal/common/thonnas/metrics"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildModule(t *testing.T) {
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := BuildModule(log, metricsProvider, reg)

	assert.NotNil(t, module)
	assert.NotNil(t, module.handler)
}

func TestNewHealthModule(t *testing.T) {
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := NewHealthModule(log, metricsProvider, reg)

	assert.NotNil(t, module)
	assert.NotNil(t, module.handler)
}

func TestRegisterRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := NewHealthModule(log, metricsProvider, reg)
	router := gin.New()

	module.RegisterRoutes(router)

	tests := []struct {
		name       string
		path       string
		method     string
		wantStatus int
	}{
		{
			name:       "Health check endpoint",
			path:       "/health",
			method:     "GET",
			wantStatus: http.StatusOK,
		},
		{
			name:       "Liveness probe endpoint",
			path:       "/health/live",
			method:     "GET",
			wantStatus: http.StatusOK,
		},
		{
			name:       "Readiness probe endpoint",
			path:       "/health/ready",
			method:     "GET",
			wantStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest(tt.method, tt.path, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			assert.Equal(t, tt.wantStatus, w.Code)
		})
	}
}

func TestHealthModule_Integration(t *testing.T) {
	gin.SetMode(gin.TestMode)
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := BuildModule(log, metricsProvider, reg)
	router := gin.New()
	module.RegisterRoutes(router)

	req, _ := http.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	req, _ = http.NewRequest("GET", "/health/live", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	req, _ = http.NewRequest("GET", "/health/ready", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestHealthModule_RouteNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := NewHealthModule(log, metricsProvider, reg)
	router := gin.New()
	module.RegisterRoutes(router)

	req, _ := http.NewRequest("GET", "/health/nonexistent", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestHealthModule_ConcurrentRequests(t *testing.T) {
	gin.SetMode(gin.TestMode)
	log := logger.New("test", "debug")
	metricsProvider := thonnasmetrics.NewNoOpMetricsProvider()
	reg := NewRegistry()

	module := NewHealthModule(log, metricsProvider, reg)
	router := gin.New()
	module.RegisterRoutes(router)

	done := make(chan bool)

	for i := 0; i < 10; i++ {
		go func() {
			defer func() { done <- true }()

			req, _ := http.NewRequest("GET", "/health", nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			require.Equal(t, http.StatusOK, w.Code)
		}()
	}

	for i := 0; i < 10; i++ {
		<-done
	}
}

