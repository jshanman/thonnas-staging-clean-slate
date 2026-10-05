# API-Go Module Pattern Rules

## MANDATORY: Folder Structure

**ALL module code MUST be in `api-go/internal/modules/{module-name}/`**

**Generic utilities ONLY in `api-go/internal/common/`**

**RESPECT Go convention: `internal/` provides package visibility control**

### ✅ CORRECT Structure

```
api-go/internal/
├── modules/              # ALL module code
│   ├── auth/
│   ├── users/
│   └── health/
├── common/               # ONLY generic utilities
│   ├── database/
│   ├── logger/
│   ├── utils/
│   └── errors/
├── middleware/           # Global HTTP middleware (OK at root)
└── config/               # Global configuration (OK at root)
```

### ❌ WRONG: Module code in shared/

```
❌ BAD:
internal/shared/auth/     # NO! Modules go in modules/

✅ GOOD:
internal/modules/auth/   # YES! Clear module boundary
```

---

## Module Structure Standards

Every module MUST follow this structure:

```
internal/modules/{module_name}/
├── module.go              # Module definition (BuildModule, NewModule)
├── interfaces.go          # Service and repository interfaces
├── service.go             # Business logic implementation
├── repository.go          # Data access implementation
├── handler.go             # HTTP handlers
├── models.go              # DTOs and domain models
├── middleware.go          # Module-specific middleware (optional)
├── service_test.go        # Service tests
├── repository_test.go     # Repository tests
└── handler_test.go        # Handler tests
```

---

## Module.go Pattern

### MANDATORY: BuildModule and NewModule Functions

```go
// internal/modules/auth/module.go
package auth

import (
    "thonnas/api-go/internal/common/logger"
    "thonnas/api-go/internal/config"
    "thonnas/api-go/internal/modules/users"
)

// Module represents the auth module
type Module struct {
    config     *config.Config
    logger     *logger.Logger
    service    Service      // Interface (not concrete type)
    repository Repository   // Interface (not concrete type)
    handler    *Handler
}

// BuildModule creates a module with minimal dependencies (early initialization)
// Used when module needs to be registered before all dependencies are available
func BuildModule(cfg *config.Config, log *logger.Logger) (*Module, error) {
    return &Module{
        config: cfg,
        logger: log,
    }, nil
}

// NewModule creates a fully initialized module with all dependencies
// Used for standard module initialization
func NewModule(cfg *config.Config, log *logger.Logger, userService users.Service) (*Module, error) {
    repo := NewRepository(log, cfg)
    service := NewService(log, repo, userService)
    handler := NewHandler(log, service)

    return &Module{
        config:     cfg,
        logger:     log,
        service:    service,
        repository: repo,
        handler:    handler,
    }, nil
}

// Exports - Return interfaces, not concrete types
func (m *Module) Service() Service {
    return m.service
}

func (m *Module) Handler() *Handler {
    return m.handler
}
```

---

## Interface-Based Dependencies

### CRITICAL: Export interfaces, not concrete types

### ✅ CORRECT: Interface exports

```go
// internal/modules/auth/interfaces.go
package auth

import "context"

// Service defines what the auth module provides to other modules
type Service interface {
    Login(ctx context.Context, email, password string) (string, error)
    ValidateToken(ctx context.Context, token string) (string, error)
}

// Repository defines data access interface
type Repository interface {
    FindUserByEmail(ctx context.Context, email string) (*User, error)
    StoreRefreshToken(ctx context.Context, userID, token string) error
}

// Exports return interfaces
func (m *Module) Service() Service {
    return m.service  // service implements Service interface
}
```

### ❌ WRONG: Exporting concrete types

```go
// ❌ BAD: Exporting concrete implementation
func (m *Module) Service() *AuthServiceImpl {
    return m.service
}

// ✅ GOOD: Exporting interface
func (m *Module) Service() Service {
    return m.service
}
```

---

## Avoiding Import Cycles

**Go enforces no import cycles at compile time.**

### Common Scenarios

#### Scenario 1: Mutual Dependencies

**Problem:**
```go
// ❌ WILL NOT COMPILE
package auth
import "thonnas/api-go/internal/modules/users"

package users
import "thonnas/api-go/internal/modules/auth"
// Error: import cycle not allowed
```

**Solution: Extract shared interface**

```go
// internal/common/interfaces/user_validator.go
package interfaces

type UserValidator interface {
    ValidateUser(ctx context.Context, userID string) (bool, error)
}

// internal/modules/auth/service.go
package auth
import "thonnas/api-go/internal/common/interfaces"

type Service struct {
    userValidator interfaces.UserValidator
}

// internal/modules/users/service.go implements the interface
package users

func (s *Service) ValidateUser(ctx context.Context, userID string) (bool, error) {
    // Implementation
}
```

#### Scenario 2: Event-Based Communication

**Use event bus for decoupling:**

```go
// internal/common/events/bus.go
type EventBus interface {
    Publish(event string, data interface{}) error
    Subscribe(event string, handler func(data interface{})) error
}

// Auth module publishes events
func (s *Service) Login() {
    s.eventBus.Publish("user.logged_in", UserEvent{UserID: id})
}

// Users module subscribes
func (s *Service) Initialize() {
    s.eventBus.Subscribe("user.logged_in", s.handleUserLogin)
}
```

---

## Cross-Module Dependencies

### ✅ CORRECT: Interface injection

```go
// In users module
type Service struct {
    logger      *logger.Logger
    authService auth.Service  // Interface from auth module
}

func NewService(log *logger.Logger, authSvc auth.Service) Service {
    return Service{
        logger:      log,
        authService: authSvc,
    }
}
```

### ✅ CORRECT: Module imports

```go
// internal/modules/users/module.go
package users

import (
    "thonnas/api-go/internal/modules/auth"  // Import package
)

func NewModule(cfg *config.Config, log *logger.Logger, authModule *auth.Module) (*Module, error) {
    // Use auth module's exported Service interface
    authService := authModule.Service()
    
    service := NewService(log, authService)
    // ...
}
```

---

## Common Folder Decision Tree

**Use this decision tree to determine if code belongs in `common/`:**

```
Is the code module-specific?
├─ YES → Place in modules/{module}/
└─ NO → Is it business logic or domain-specific?
    ├─ YES → Place in modules/{module}/ (even if used by multiple modules)
    └─ NO → Is it a generic utility with no domain knowledge?
        ├─ YES → Place in common/
        └─ NO → Place in modules/{module}/ and export interface
```

### Examples

| Code | Location | Rationale |
|------|----------|-----------|
| Logger | `common/logger/logger.go` | Generic utility, no domain knowledge |
| User entity/model | `modules/users/models.go` | Domain-specific, belongs in users module |
| Database connection | `common/database/connection.go` | Generic infrastructure |
| AuthService interface | `modules/auth/interfaces.go` | Module-specific, even if used by other modules |
| Error types (generic) | `common/errors/errors.go` | Generic error handling |
| JWT validation | `modules/auth/service.go` | Auth-specific logic |

---

## Middleware Placement

### Global Middleware (at internal/ root)

```
internal/middleware/
├── cors.go           # Generic CORS middleware
├── logger.go         # Request logging middleware
└── recovery.go       # Panic recovery middleware
```

**Global middleware:**
- Used by all routes
- No domain knowledge
- Infrastructure concern

### Module-Specific Middleware

```
internal/modules/auth/
└── middleware.go     # Auth-specific middleware
```

**Module middleware:**
- Used only by module routes
- Has domain knowledge
- Lives within module

---

## Test Co-location

### ✅ CORRECT: Tests co-located with code

```
internal/modules/auth/
├── service.go
├── service_test.go        # Test next to source
├── repository.go
├── repository_test.go     # Test next to source
├── handler.go
└── handler_test.go        # Test next to source
```

### Integration Tests

Integration tests can be in module or at project root:

```
api-go/
├── internal/modules/auth/
│   └── integration_test.go
└── tests/
    └── auth_integration_test.go
```

---

## Package Naming

### ✅ CORRECT: Package = module name

```go
// internal/modules/auth/service.go
package auth

// internal/modules/users/service.go
package users
```

### ❌ WRONG: Nested packages

```go
// ❌ BAD
package auth.service

// ✅ GOOD
package auth
```

---

## Common Mistakes to Avoid

### ❌ MISTAKE 1: Circular imports

Go will **not compile** with import cycles. Use interfaces in `common/` if needed.

### ❌ MISTAKE 2: Exporting concrete types from module

```go
// ❌ BAD
func (m *Module) Service() *ServiceImpl

// ✅ GOOD
func (m *Module) Service() Service  // Interface
```

### ❌ MISTAKE 3: Missing module.go

Every module MUST have `module.go` with `BuildModule()` and `NewModule()`.

### ❌ MISTAKE 4: Business logic in common/

```go
// ❌ BAD: common/utils/user_helpers.go
func CalculateUserAge(birthDate time.Time) int {
    // Domain logic
}

// ✅ GOOD: modules/users/service.go
func (s *Service) CalculateAge(birthDate time.Time) int {
    // Business logic in module
}
```

---

## Summary

1. ✅ ALL module code in `internal/modules/{module}/`
2. ✅ ONLY generic utilities in `internal/common/`
3. ✅ Module has `module.go` with BuildModule/NewModule
4. ✅ Module exports interfaces, not concrete types
5. ✅ Cross-module dependencies use interfaces
6. ✅ Tests co-located with source
7. ✅ Global middleware/config at internal/ root is OK
8. ✅ Follow Go naming conventions
9. ❌ NO import cycles (Go enforces this)
10. ❌ NO module-specific code in common/
11. ❌ NO direct imports to module internals (use package)
12. ❌ NO business logic in common/

---

**Last Updated:** 2025-11-02  
**Status:** Active


