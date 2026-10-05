package appmodule

import (
	"context"
	"fmt"

	"thonnas/api-go/internal/common/thonnas"

	"github.com/gin-gonic/gin"
)

// ModuleMetadata defines the metadata for a module (like NestJS @Module decorator)
type ModuleMetadata struct {
	// Name is the unique identifier for this module
	Name string

	// Imports lists the module names that this module depends on
	// These dependencies will be injected during the Wire phase
	Imports []string

	// WireLast defers this module until after all other modules have wired.
	// Use for job-runner backends that collect ThonnasWorker jobs registered during Wire.
	WireLast bool

	// BuildFunc is called during the Build phase (no dependencies available)
	// Use this to register MQTT handlers, initialize lightweight state, etc.
	BuildFunc BuildModuleFunc

	// WireFunc is called during the Wire phase (all dependencies are available)
	// Use this to create the full module with all dependencies injected
	WireFunc WireModuleFunc
}

// BuildModuleFunc is called during the Build phase
// Returns a BuildResult containing the partially initialized module
type BuildModuleFunc func(ctx *BuildContext) (*BuildResult, error)

// WireModuleFunc is called during the Wire phase
// Receives BuildResult from Build phase and dependencies from imported modules
// Returns the fully wired module instance
type WireModuleFunc func(buildResult *BuildResult, deps ModuleDependencies) (Module, error)

// BuildContext provides access to shared infrastructure during Build phase
type BuildContext struct {
	Config    interface{} // Application config (cast to *config.Config)
	Logger    interface{} // Logger (cast to *logger.Logger)
	Contracts *thonnas.Bundle // Portable Thonnas bindings (modules use ThonnasMetrics, not vendor MetricsProvider)
	Router    *gin.Engine // Router for route registration
	Cache     interface{} // Shared cache (cast to *cache.Cache)
}

// BuildResult contains the result of the Build phase
// This is passed to the Wire phase for final module construction
type BuildResult struct {
	// PartialModule is any state created during Build phase
	// This will be passed to WireFunc for final wiring
	PartialModule interface{}

	// Exports maps export names to values that other modules can import
	// Example: {"client": mqttClient, "service": authService}
	Exports map[string]interface{}
}

// ModuleDependencies maps imported module names to their exported values
// Example: dependencies["mqtt"].Get("client") returns the MQTT client
type ModuleDependencies map[string]*BuildResult

// Get retrieves an exported value from a dependency
func (d ModuleDependencies) Get(moduleName, exportName string) (interface{}, error) {
	dep, ok := d[moduleName]
	if !ok {
		return nil, fmt.Errorf("dependency module '%s' not found", moduleName)
	}

	if dep.Exports == nil {
		return nil, fmt.Errorf("module '%s' has no exports", moduleName)
	}

	value, ok := dep.Exports[exportName]
	if !ok {
		return nil, fmt.Errorf("module '%s' does not export '%s'", moduleName, exportName)
	}

	return value, nil
}

// GetRequired retrieves an exported value and panics if not found
// Use this for required dependencies that should be validated during startup
func (d ModuleDependencies) GetRequired(moduleName, exportName string) interface{} {
	value, err := d.Get(moduleName, exportName)
	if err != nil {
		panic(fmt.Sprintf("required dependency not found: %v", err))
	}
	return value
}

// Module is the interface that all modules must implement
// This provides lifecycle hooks and metadata access
type Module interface {
	// GetName returns the module name
	GetName() string

	// RegisterRoutes registers HTTP routes (optional - can be no-op)
	RegisterRoutes(router *gin.Engine) error

	// Start starts the module (called during application startup)
	Start(ctx context.Context) error

	// Stop stops the module (called during graceful shutdown)
	Stop() error

	// GetExports returns values that other modules can import
	// This is called after Wire phase to allow other modules to access this module's services
	GetExports() map[string]interface{}
}

// BaseModule provides default implementations for Module interface
// Embed this in your module to get default no-op implementations
type BaseModule struct {
	Name string
}

// GetName returns the module name
func (m *BaseModule) GetName() string {
	return m.Name
}

// RegisterRoutes is a no-op by default (override if module has routes)
func (m *BaseModule) RegisterRoutes(router *gin.Engine) error {
	return nil
}

// Start is a no-op by default (override if module needs startup logic)
func (m *BaseModule) Start(ctx context.Context) error {
	return nil
}

// Stop is a no-op by default (override if module needs cleanup logic)
func (m *BaseModule) Stop() error {
	return nil
}

// GetExports returns empty map by default (override if module exports services)
func (m *BaseModule) GetExports() map[string]interface{} {
	return make(map[string]interface{})
}

