# Module Configuration Quick Start

## Overview

The api-go component uses a module-agnostic configuration system where each module declares its own config independently.

**Key Benefits:**
- ✅ Module independence - each module owns its config
- ✅ Type-safe access with Go generics
- ✅ Automatic discovery and aggregation
- ✅ Environment variable overrides

## Quick Start

### 1. Create a Module Config File

Create `module.config.yaml` in your module directory:

```yaml
# internal/modules/yourmodule/module.config.yaml

# Default configuration values
config:
  apiKey: "default-key"
  timeout: "5s"
  retries: 3
  endpoints:
    primary: "http://localhost:8080"
    fallback: "http://localhost:8081"

# Environment variable mappings
envMappings:
  apiKey: "YOUR_MODULE_API_KEY"
  timeout: "YOUR_MODULE_TIMEOUT"
  retries: "YOUR_MODULE_RETRIES"
  endpoints:
    primary: "YOUR_MODULE_PRIMARY_ENDPOINT"
    fallback: "YOUR_MODULE_FALLBACK_ENDPOINT"
```

### 2. Define a Config Struct

Create a struct matching your config structure:

```go
// internal/modules/yourmodule/config.go
package yourmodule

import "time"

type Config struct {
    APIKey    string            `json:"apiKey"`
    Timeout   time.Duration     `json:"timeout"`
    Retries   int               `json:"retries"`
    Endpoints EndpointsConfig   `json:"endpoints"`
}

type EndpointsConfig struct {
    Primary  string `json:"primary"`
    Fallback string `json:"fallback"`
}

func DefaultConfig() Config {
    return Config{
        APIKey:  "default-key",
        Timeout: 5 * time.Second,
        Retries: 3,
        Endpoints: EndpointsConfig{
            Primary:  "http://localhost:8080",
            Fallback: "http://localhost:8081",
        },
    }
}
```

### 3. Regenerate Aggregated Configs

Run the aggregation script:

```bash
cd api-go
make config-aggregate

# Or manually:
go run scripts/aggregate-configs.go
```

This generates:
- `internal/config/generated.go` - Type-safe Go code with pre-merged configs

### 4. Use Config in Your Module

Load the config in your module:

```go
// internal/modules/yourmodule/module.go
package yourmodule

import (
    "fmt"
    "thonnas/api-go/internal/config"
    "thonnas/api-go/internal/common/logger"
)

type Module struct {
    config       *config.Config
    moduleConfig Config
    logger       *logger.Logger
}

func NewModule(cfg *config.Config, log *logger.Logger) (*Module, error) {
    // Get module config from generated config (type-safe, direct access)
    yourmoduleCfg := cfg.Yourmodule
    
    // Map to module's Config struct (handles naming convention differences)
    moduleConfig := Config{
        APIKey:   yourmoduleCfg.Apikey,
        Timeout:  yourmoduleCfg.Timeout,
        Retries:  yourmoduleCfg.Retries,
        Endpoints: EndpointsConfig{
            Primary:  yourmoduleCfg.Endpoints.Primary,
            Fallback: yourmoduleCfg.Endpoints.Fallback,
        },
    }
    
    log.WithFields(map[string]interface{}{
        "apiKey":  "***",
        "timeout": moduleConfig.Timeout,
        "retries": moduleConfig.Retries,
    }).Info("YourModule configured")
    
    return &Module{
        config:       cfg,
        moduleConfig: moduleConfig,
        logger:       log,
    }, nil
}

func (m *Module) DoSomething() {
    // Use module config
    m.logger.Infof("Using API key: %s", m.moduleConfig.APIKey)
    m.logger.Infof("Timeout: %v", m.moduleConfig.Timeout)
}
```

### 5. Override with Environment Variables

Set environment variables to override config:

```bash
# Override specific values
export YOUR_MODULE_API_KEY="production-key"
export YOUR_MODULE_TIMEOUT="30s"
export YOUR_MODULE_RETRIES=5

# Run the application
./bin/server
```

## Alternative: Direct Field Access

Access specific values directly without mapping to module struct:

```go
// Direct access to generated config fields
apiKey := cfg.Yourmodule.Apikey
timeout := cfg.Yourmodule.Timeout
retries := cfg.Yourmodule.Retries

log.Infof("API Key: %s, Timeout: %v, Retries: %d", apiKey, timeout, retries)
```

## Build Integration

### Makefile Commands

```bash
# Aggregate configs
make config-aggregate

# Build (auto-aggregates first)
make build

# Development mode with auto-reload
make dev

# Install git hooks (auto-aggregates on commit)
make install-hooks
```

### Git Pre-commit Hook

Install the hook to automatically aggregate configs when `module.config.yaml` files change:

```bash
make install-hooks
```

Now when you commit changes to module configs, the aggregated files are automatically updated and staged.

## Configuration Hierarchy (4 Layers)

Configs are merged at BUILD TIME in this order (later overrides earlier):

```
Layer 1: module.config.yaml (module defaults)
   ↓
Layer 2: config/default.yaml (shared defaults for ALL environments)
   ↓
Layer 3: config/{environment}.yaml (dev/staging/production/test)
   ↓ (Above 3 layers compiled into binary)
Layer 4: Environment Variables (runtime overrides - secrets)
```

**Key Point**: Layers 1-3 are merged at BUILD TIME and compiled into the binary.
Only Layer 4 (env vars) happens at runtime.

## Example: WebSocket Module

See the WebSocket module for a complete example:

```bash
# Module config
cat internal/modules/websocket/module.config.yaml

# Config struct
cat internal/modules/websocket/config.go

# Usage in module
cat internal/modules/websocket/module.go
```

## Common Patterns

### Required vs Optional Config

```yaml
config:
  apiKey: null           # Required (null = must set via ENV)
  timeout: "5s"          # Optional (has default)
  retries: 3             # Optional (has default)
```

### Nested Configuration

```yaml
config:
  database:
    host: "localhost"
    port: 5432
    pool:
      minSize: 2
      maxSize: 10

envMappings:
  database:
    host: "DB_HOST"
    port: "DB_PORT"
    pool:
      minSize: "DB_POOL_MIN_SIZE"
      maxSize: "DB_POOL_MAX_SIZE"
```

### Production Validation

```go
func NewModule(cfg *config.Config, log *logger.Logger) (*Module, error) {
    moduleConfig, err := config.GetModuleConfig[Config](cfg, "yourmodule")
    if err != nil {
        return nil, err
    }
    
    // Validate required config in production
    if cfg.Environment() == "production" {
        if moduleConfig.APIKey == "" || moduleConfig.APIKey == "default-key" {
            return nil, fmt.Errorf("YOUR_MODULE_API_KEY must be set in production")
        }
    }
    
    return &Module{moduleConfig: moduleConfig}, nil
}
```

## Troubleshooting

### Config Not Found

```
Error: module config not found: yourmodule
```

**Solution**: Run `make config-aggregate` to regenerate configs.

### Type Mismatch

```
Error: config value has wrong type for key yourmodule.timeout: expected time.Duration, got string
```

**Solution**: Ensure YAML value format matches expected type:
- Duration: `"5s"` (quoted string in YAML)
- Integer: `123` (no quotes)
- Boolean: `true` or `false` (no quotes)

### ENV Variable Not Working

**Solution**: 
1. Check `config/env-mappings.yaml` has correct mapping
2. Ensure ENV variable name matches exactly (case-sensitive)
3. Restart application after setting ENV variable

## Documentation

For comprehensive documentation, see:
- **[Module Config Pattern](docs/MODULE_CONFIG_PATTERN.md)** - Full documentation
- **[Module System](docs/MODULE_SYSTEM.md)** - Module architecture
- **[NestJS Config Pattern](../api/docs/MODULE_CONFIG_PATTERN.md)** - Inspiration

## Summary

**Core Workflow:**
1. Create `module.config.yaml` with defaults and env mappings
2. Define matching Go struct in your module
3. Run `make config-aggregate` (generates type-safe Go code)
4. Access config directly: `cfg.Yourmodule.Apikey`
5. Override with environment variables at runtime

That's it! Your module now has independent, type-safe configuration compiled into the binary.


