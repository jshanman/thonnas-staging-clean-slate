package main

import (
	"fmt"
	"net/http"
	_ "net/http/pprof" // Import pprof for profiling endpoints
	"os"
	"os/signal"
	"syscall"

	"thonnas/api-go/internal/app"
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/common/thonnas"
	"thonnas/api-go/internal/common/tracing"
	"thonnas/api-go/internal/common/version"
	"thonnas/api-go/internal/config"
	"thonnas/api-go/internal/middleware"

	"github.com/gin-gonic/gin"
)

// bootstrapApplication creates and initializes the application infrastructure
// Returns the application instance ready to initialize modules
func bootstrapApplication() (*app.Application, error) {
	// Load configuration from environment
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("failed to load configuration: %w", err)
	}

	// Validate configuration immediately (fail fast)
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("configuration validation failed: %w", err)
	}

	// Initialize logger
	log := logger.New(cfg.Loglevel(), cfg.Logformat())

	// Thonnas contracts bundle (metrics/logger/email/events) — wiring registered via common/thonnas imports side-effects
	thonnasBundle, err := thonnas.NewBundle(cfg, log)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve Thonnas contracts: %w", err)
	}

	log.WithFields(map[string]interface{}{
		"provider": cfg.Metricsprovider(),
		"enabled":  cfg.Metricsenabled(),
	}).Info("Thonnas contracts bundle initialized (metrics + portable bindings)")

	// Initialize distributed tracing (OpenTelemetry)
	// Exports traces to SigNoz for visualization and analysis
	tracingConfig := &tracing.TracingConfig{
		Enabled:      cfg.Metricsenabled(), // Use same flag as metrics
		ServiceName:  cfg.Servicename(),
		Environment:  cfg.Environment(),
		OTelEndpoint: cfg.Otelendpoint(),
	}
	tracingShutdown, err := tracing.InitTracing(tracingConfig, log)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize tracing: %w", err)
	}

	// Log environment and configuration (helps with debugging/auditing)
	versionInfo := version.Get()
	log.WithFields(map[string]interface{}{
		"version":         versionInfo.Version,
		"commit":          versionInfo.Commit,
		"build_time":      versionInfo.BuildTime,
		"go_version":      versionInfo.GoVersion,
		"environment":     cfg.Environment(),
		"service_name":    cfg.Servicename(),
		"gin_mode":        cfg.Ginmode(),
		"port":            cfg.Port(),
		"metrics_enabled": cfg.Metricsenabled(),
		"tracing_enabled": cfg.Metricsenabled(),
	}).Info("🚀 Starting api-go service")

	// Set Gin mode
	if cfg.Ginmode() == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	// Create Gin router
	router := gin.New()

	// Apply global middleware (like NestJS global pipes/guards)
	// Order matters: Tracing first (creates span), then correlation ID, then logging
	router.Use(middleware.TracingMiddleware())       // OpenTelemetry distributed tracing
	router.Use(middleware.CorrelationIDMiddleware()) // Add correlation ID to all requests
	router.Use(middleware.LoggerMiddleware(log))     // Log requests (includes correlation ID)
	router.Use(middleware.CORSMiddleware(cfg))       // CORS handling
	router.Use(middleware.RecoveryMiddleware(log))   // Panic recovery

	// Register pprof endpoints for profiling/debugging (only in development)
	// Access at http://localhost:3001/debug/pprof/
	// Profiles: heap, goroutine, threadcreate, block, mutex, cpu
	if cfg.Ginmode() != "release" {
		log.Info("Registering pprof endpoints at /debug/pprof/ (development mode only)")
		router.Any("/debug/pprof/*any", gin.WrapH(http.DefaultServeMux))
	}

	// Get module definitions (centralized module registry)
	// To add a new module, edit internal/app/modules.go - no changes needed here!
	moduleMetadata := app.GetModuleMetadata()

	// Create application with all modules
	// This will handle two-phase initialization: Build → Wire → Start
	application := app.NewApplication(
		cfg,
		log,
		thonnasBundle,
		tracingShutdown,
		router,
		moduleMetadata,
	)

	// Initialize all modules (Build → Wire → Register Routes)
	if err := application.Initialize(); err != nil {
		return nil, fmt.Errorf("failed to initialize application modules: %w", err)
	}

	log.Info("HTTP/2 support enabled (requires TLS in production)")

	return application, nil
}

func main() {
	// Note: Environment variables are loaded by the runtime (Docker, Kubernetes, etc.)
	// For local development outside Docker, manually source ENV.local:
	//   PowerShell: Get-Content ENV.local | ForEach-Object { $var = $_.Split('='); [Environment]::SetEnvironmentVariable($var[0], $var[1]) }
	//   Bash: export $(cat ENV.local | xargs)
	// Or use an IDE run configuration to load ENV.local

	// SINGLE EXIT POINT PATTERN
	// Only main() calls os.Exit() - all other functions return errors
	exitCode := run()
	os.Exit(exitCode)
}

// run contains the main application logic and returns exit code
// This pattern allows defer statements to execute before exit
func run() int {
	// Bootstrap application infrastructure and modules
	application, err := bootstrapApplication()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to bootstrap application: %v\n", err)
		return 1
	}

	// Start all modules and HTTP server
	serverErrors, err := application.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start application: %v\n", err)
		return 1
	}

	// Wait for shutdown signal or server error
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	// Block until shutdown signal or server error
	select {
	case sig := <-shutdown:
		fmt.Printf("Shutdown signal received: %s\n", sig.String())

	case err := <-serverErrors:
		fmt.Fprintf(os.Stderr, "Server error, initiating shutdown: %v\n", err)
	}

	// Graceful shutdown
	if err := application.Shutdown(); err != nil {
		fmt.Fprintf(os.Stderr, "Shutdown failed: %v\n", err)
		return 1
	}

	fmt.Println("Application exited cleanly")
	return 0
}

