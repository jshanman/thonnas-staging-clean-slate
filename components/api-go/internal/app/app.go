package app

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/common/thonnas"
	"thonnas/api-go/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/patrickmn/go-cache"
)

// Application orchestrates module lifecycle (like NestJS ApplicationFactory)
// Handles two-phase initialization: Build → Wire → Start
type Application struct {
	// Infrastructure
	config          *config.Config
	router          *gin.Engine
	logger          *logger.Logger
	thonnasBundle   *thonnas.Bundle
	tracingShutdown func(context.Context) error
	server          *http.Server
	cache           *cache.Cache

	// Module registry
	moduleMetadata []*ModuleMetadata
	modules        []Module
	buildResults   map[string]*BuildResult
}

// NewApplication creates a new application with the given module definitions
func NewApplication(
	cfg *config.Config,
	log *logger.Logger,
	thonnasBundle *thonnas.Bundle,
	tracingShutdown func(context.Context) error,
	router *gin.Engine,
	moduleMetadata []*ModuleMetadata,
) *Application {
	// Create shared cache for inter-module state
	cache := cache.New(5*time.Minute, 10*time.Minute)

	return &Application{
		config:          cfg,
		router:          router,
		logger:          log,
		thonnasBundle:   thonnasBundle,
		tracingShutdown: tracingShutdown,
		cache:           cache,
		moduleMetadata:  moduleMetadata,
		modules:         make([]Module, 0, len(moduleMetadata)),
		buildResults:    make(map[string]*BuildResult),
	}
}

// Initialize performs two-phase module initialization
// Phase 1: Build all modules (no dependencies)
// Phase 2: Wire modules with dependencies
func (app *Application) Initialize() error {
	app.logger.Info("Initializing application modules...")

	// Phase 1: Build all modules
	if err := app.buildPhase(); err != nil {
		return fmt.Errorf("build phase failed: %w", err)
	}

	// Phase 2: Wire modules with dependencies
	if err := app.wirePhase(); err != nil {
		return fmt.Errorf("wire phase failed: %w", err)
	}

	// Phase 3: Register routes
	if err := app.registerRoutes(); err != nil {
		return fmt.Errorf("route registration failed: %w", err)
	}

	app.logger.WithField("module_count", len(app.modules)).Info("Application modules initialized successfully")
	return nil
}

// buildPhase executes the Build phase for all modules
// Modules are built in registration order (imports don't matter yet)
func (app *Application) buildPhase() error {
	app.logger.Info("Phase 1: Building modules...")

	buildCtx := &BuildContext{
		Config:    app.config,
		Logger:    app.logger,
		Contracts: app.thonnasBundle,
		Router:    app.router,
		Cache:     app.cache,
	}

	for _, metadata := range app.moduleMetadata {
		app.logger.WithField("module", metadata.Name).Debug("Building module...")

		// Call BuildFunc to get partial module and exports
		buildResult, err := metadata.BuildFunc(buildCtx)
		if err != nil {
			return fmt.Errorf("failed to build module '%s': %w", metadata.Name, err)
		}

		// Store build result for Wire phase
		app.buildResults[metadata.Name] = buildResult

		app.logger.WithFields(map[string]interface{}{
			"module":       metadata.Name,
			"export_count": len(buildResult.Exports),
		}).Debug("Module built successfully")
	}

	app.logger.WithField("module_count", len(app.buildResults)).Info("Phase 1 complete: All modules built")
	return nil
}

// wirePhase executes the Wire phase for all modules
// Modules are wired in dependency order (topological sort)
func (app *Application) wirePhase() error {
	app.logger.Info("Phase 2: Wiring modules with dependencies...")

	// Topological sort to resolve dependency order
	orderedModules, err := app.topologicalSort()
	if err != nil {
		return fmt.Errorf("failed to resolve module dependencies: %w", err)
	}
	orderedModules = deferWireLastModules(orderedModules)

	// Wire modules in dependency order
	for _, metadata := range orderedModules {
		app.logger.WithFields(map[string]interface{}{
			"module":  metadata.Name,
			"imports": metadata.Imports,
		}).Debug("Wiring module...")

		// Gather dependencies from imported modules
		deps := make(ModuleDependencies)
		for _, importName := range metadata.Imports {
			buildResult, ok := app.buildResults[importName]
			if !ok {
				return fmt.Errorf("module '%s' imports undefined module '%s'", metadata.Name, importName)
			}
			deps[importName] = buildResult
		}

		// Get build result for this module
		buildResult := app.buildResults[metadata.Name]

		// Call WireFunc to create fully initialized module
		module, err := metadata.WireFunc(buildResult, deps)
		if err != nil {
			return fmt.Errorf("failed to wire module '%s': %w", metadata.Name, err)
		}

		// Store wired module
		app.modules = append(app.modules, module)

		// Update build result with latest exports from wired module
		buildResult.Exports = module.GetExports()

		app.logger.WithField("module", metadata.Name).Debug("Module wired successfully")
	}

	app.logger.WithField("module_count", len(app.modules)).Info("Phase 2 complete: All modules wired")
	return nil
}

// registerRoutes registers HTTP routes for all modules
func (app *Application) registerRoutes() error {
	app.logger.Info("Phase 3: Registering module routes...")

	for _, module := range app.modules {
		if err := module.RegisterRoutes(app.router); err != nil {
			return fmt.Errorf("failed to register routes for module '%s': %w", module.GetName(), err)
		}

		app.logger.WithField("module", module.GetName()).Debug("Routes registered")
	}

	app.logger.Info("Phase 3 complete: All routes registered")
	return nil
}

// topologicalSort performs dependency resolution using Kahn's algorithm
// Returns modules in dependency order (dependencies before dependents)
func (app *Application) topologicalSort() ([]*ModuleMetadata, error) {
	// Build dependency graph
	inDegree := make(map[string]int)
	adjacency := make(map[string][]*ModuleMetadata)
	moduleMap := make(map[string]*ModuleMetadata)

	// Initialize in-degree and module map
	for _, metadata := range app.moduleMetadata {
		inDegree[metadata.Name] = 0
		moduleMap[metadata.Name] = metadata
	}

	// Build adjacency list and count in-degrees
	for _, metadata := range app.moduleMetadata {
		for _, importName := range metadata.Imports {
			// Validate import exists
			if _, ok := moduleMap[importName]; !ok {
				return nil, fmt.Errorf("module '%s' imports undefined module '%s'", metadata.Name, importName)
			}

			// Add edge: imported module -> current module
			adjacency[importName] = append(adjacency[importName], metadata)
			inDegree[metadata.Name]++
		}
	}

	// Find all modules with no dependencies (in-degree = 0)
	queue := make([]*ModuleMetadata, 0)
	for _, metadata := range app.moduleMetadata {
		if inDegree[metadata.Name] == 0 {
			queue = append(queue, metadata)
		}
	}

	// Topological sort using BFS
	result := make([]*ModuleMetadata, 0, len(app.moduleMetadata))
	for len(queue) > 0 {
		// Dequeue
		current := queue[0]
		queue = queue[1:]
		result = append(result, current)

		// Process dependents
		for _, dependent := range adjacency[current.Name] {
			inDegree[dependent.Name]--
			if inDegree[dependent.Name] == 0 {
				queue = append(queue, dependent)
			}
		}
	}

	// Check for circular dependencies
	if len(result) != len(app.moduleMetadata) {
		return nil, fmt.Errorf("circular dependency detected in module imports")
	}

	return result, nil
}

// deferWireLastModules moves WireLast modules to the end while preserving order.
func deferWireLastModules(ordered []*ModuleMetadata) []*ModuleMetadata {
	var normal, last []*ModuleMetadata
	for _, metadata := range ordered {
		if metadata.WireLast {
			last = append(last, metadata)
			continue
		}
		normal = append(normal, metadata)
	}
	return append(normal, last...)
}

// Start starts all modules in order
func (app *Application) Start() (<-chan error, error) {
	app.logger.Info("Starting application modules...")

	ctx := context.Background()

	// Start all modules in order
	for _, module := range app.modules {
		app.logger.WithField("module", module.GetName()).Debug("Starting module...")

		if err := module.Start(ctx); err != nil {
			return nil, fmt.Errorf("failed to start module '%s': %w", module.GetName(), err)
		}

		app.logger.WithField("module", module.GetName()).Debug("Module started successfully")
	}

	app.logger.WithField("module_count", len(app.modules)).Info("All modules started successfully")

	// Create HTTP server
	app.server = &http.Server{
		Addr:              fmt.Sprintf(":%s", app.config.Port()),
		Handler:           app.router,
		ReadTimeout:       app.config.Httpreadtimeout(),
		ReadHeaderTimeout: app.config.Httpreadheadertimeout(),
		WriteTimeout:      app.config.Httpwritetimeout(),
		IdleTimeout:       app.config.Httpidletimeout(),
		MaxHeaderBytes:    app.config.Httpmaxheaderbytes(),
	}

	// Log server info
	app.logger.Info(fmt.Sprintf("Starting HTTP server on port %s", app.config.Port()))
	app.logger.Info(fmt.Sprintf("Health check: http://localhost:%s/health", app.config.Port()))

	// Create error channel for server errors
	serverErrors := make(chan error, 1)

	// Start server in goroutine
	go func() {
		if err := app.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			app.logger.WithField("error", err.Error()).Error("Server error")
			serverErrors <- err
		}
	}()

	return serverErrors, nil
}

// Shutdown gracefully stops all modules in reverse order
func (app *Application) Shutdown() error {
	app.logger.Info("Shutting down application...")

	// Create shutdown context
	ctx, cancel := context.WithTimeout(context.Background(), app.config.Httpshutdowntimeout())
	defer cancel()

	// Stop modules in reverse order (reverse dependency order)
	for i := len(app.modules) - 1; i >= 0; i-- {
		module := app.modules[i]
		app.logger.WithField("module", module.GetName()).Debug("Stopping module...")

		if err := module.Stop(); err != nil {
			app.logger.WithFields(map[string]interface{}{
				"module": module.GetName(),
				"error":  err.Error(),
			}).Warn("Failed to stop module")
		} else {
			app.logger.WithField("module", module.GetName()).Debug("Module stopped successfully")
		}
	}

	// Shutdown HTTP server
	if app.server != nil {
		app.logger.Info("Shutting down HTTP server...")
		if err := app.server.Shutdown(ctx); err != nil {
			app.logger.WithField("error", err.Error()).Error("Server forced to shutdown")
			return fmt.Errorf("server shutdown error: %w", err)
		}
	}

	// Close Thonnas contract backends (cache + metrics — not exposed to feature modules)
	if app.thonnasBundle != nil {
		app.logger.Info("Closing cache provider...")
		if err := app.thonnasBundle.ShutdownCache(); err != nil {
			app.logger.WithField("error", err.Error()).Warn("Failed to close cache provider")
		}

		app.logger.Info("Closing metrics provider...")
		if err := app.thonnasBundle.ShutdownMetrics(); err != nil {
			app.logger.WithField("error", err.Error()).Warn("Failed to close metrics provider")
		}
	}

	// Close tracing provider
	if app.tracingShutdown != nil {
		app.logger.Info("Closing tracing provider...")
		if err := app.tracingShutdown(context.Background()); err != nil {
			app.logger.WithField("error", err.Error()).Warn("Failed to close tracing provider")
		}
	}

	app.logger.Info("Application shutdown complete")
	return nil
}

