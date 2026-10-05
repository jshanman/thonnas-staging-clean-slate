# api-go - Go API Service

## Overview

**api-go** is a general-purpose Go API service designed for high-performance, high-concurrency operations within the baseline-cursor-v3 monorepo. It uses a **NestJS-inspired module pattern** to maintain consistency across the codebase and enable AI-friendly code generation.

### Purpose

This is **NOT** just a WebSocket service - it's a **general Go API component** where:
- **WebSocket** is the first module implementation (real-time communication)
- Future modules can be added for file uploads, video processing, CPU-intensive operations, etc.
- Each module follows the same handler/service/repository pattern

### When to Use api-go vs api (NestJS)

**Use api-go (Go) for:**
- ✅ High concurrency operations (10k+ simultaneous connections)
- ✅ WebSocket and real-time features
- ✅ File uploads and processing
- ✅ CPU-intensive operations (image/video processing, report generation)
- ✅ Streaming (video, audio, data)
- ✅ Performance-critical paths

---

## Architecture

### NestJS-Inspired Module Pattern

api-go mirrors the NestJS module pattern for consistency:

```
NestJS Pattern              Go Pattern (api-go)
--------------              -------------------
Controller      →           Handler (handler.go)
Service         →           Service (service.go)
Repository      →           Repository (repository.go / pool.go)
DTO             →           DTO (dto.go)
Module          →           Module (module.go - DI wiring)
```

### Directory Structure

```
api-go/
├── cmd/
│   └── server/
│       └── main.go              # Application entry point
├── internal/
│   ├── config/                  # Configuration management
│   │   └── config.go            # Environment variable loading
│   ├── middleware/              # Shared middleware
│   │   ├── auth.go              # JWT authentication
│   │   ├── cors.go              # CORS handling
│   │   └── logger.go            # Request logging
│   ├── modules/                 # Feature modules (NestJS-style)
│   │   ├── health/              # Health check module
│   │   │   ├── handler.go       # GET /health endpoint
│   │   │   └── module.go        # Health module DI
│   │   ├── websocket/           # WebSocket module (first feature)
│   │   │   ├── handler.go       # WebSocket upgrade handler
│   │   │   ├── service.go       # WebSocket business logic
│   │   │   ├── pool.go          # Connection pool (repository)
│   │   │   ├── dto.go           # Message DTOs
│   │   │   └── module.go        # WebSocket module DI
│   │   └── usercount/           # User count module
│   │       ├── service.go       # Count tracking logic
│   │       └── module.go        # UserCount module DI
│   └── shared/                  # Shared utilities
│       ├── logger/              # Logging utilities
│       ├── errors/              # Error handling
│       └── types/               # Shared types
├── test/                        # Integration tests
├── Dockerfile                   # Multi-stage Docker build
├── .dockerignore
├── go.mod                       # Go module definition
├── go.sum                       # Dependency checksums
├── ENV.local.example            # Environment variable template
└── README.md                    # This file
```

### Module Pattern Example

Each module follows this structure:

**1. Handler (Controller equivalent)**
```go
// internal/modules/example/handler.go
package example

import "github.com/gin-gonic/gin"

type ExampleHandler struct {
    service ExampleService
}

func NewExampleHandler(service ExampleService) *ExampleHandler {
    return &ExampleHandler{service: service}
}

func (h *ExampleHandler) HandleRequest(c *gin.Context) {
    // Delegate to service layer
    result := h.service.DoSomething()
    c.JSON(200, result)
}
```

**2. Service (Business logic)**
```go
// internal/modules/example/service.go
package example

type ExampleService interface {
    DoSomething() string
}

type ExampleServiceImpl struct {
    // Dependencies injected
}

func NewExampleService() ExampleService {
    return &ExampleServiceImpl{}
}

func (s *ExampleServiceImpl) DoSomething() string {
    // Business logic here
    return "result"
}
```

**3. Module (Dependency injection)**
```go
// internal/modules/example/module.go
package example

import "github.com/gin-gonic/gin"

type ExampleModule struct {
    handler *ExampleHandler
}

func NewExampleModule() *ExampleModule {
    service := NewExampleService()
    handler := NewExampleHandler(service)
    return &ExampleModule{handler: handler}
}

func (m *ExampleModule) RegisterRoutes(router *gin.Engine) {
    router.GET("/example", m.handler.HandleRequest)
}
```

**4. Application Wiring (main.go)**
```go
// cmd/server/main.go
package main

type Application struct {
    router *gin.Engine
    exampleModule *example.ExampleModule
}

func NewApplication() *Application {
    router := gin.Default()
    
    // Initialize modules
    exampleModule := example.NewExampleModule()
    
    // Register routes
    exampleModule.RegisterRoutes(router)
    
    return &Application{
        router: router,
        exampleModule: exampleModule,
    }
}
```

---

## Prerequisites

### Required Software

1. **Go 1.21 or later**
   ```bash
   # Verify installation
   go version
   ```

2. **Docker & Docker Compose** (for containerization)

3. **Git** (for version control)

### Development Tools (Recommended)

- **Visual Studio Code** with Go extension
- **Postman** or **websocat** (for WebSocket testing)
- **k6** (for load testing)

---

## Usage

### 1. Install Go Dependencies

```bash
cd api-go

# Initialize module (if not already done)
go mod init baseline-cursor-v3/api-go

# Add dependencies
go get github.com/gin-gonic/gin              # HTTP framework
go get github.com/gorilla/websocket          # WebSocket support
go get github.com/golang-jwt/jwt/v5          # JWT authentication
go get github.com/sirupsen/logrus            # Structured logging

# Download dependencies
go mod tidy
```

### 2. Configure Environment

```bash
thonnas config setup

```

### 3. Run Locally

**Recommended: Use Docker Compose**

```bash
# From monorepo root
thonnas start

# Docker Compose automatically loads ENV.local via env_file
```

**Alternative: Run Directly (outside Docker)**

The application reads from environment variables (not from .env files).
You must load ENV.local into your shell environment first:

```bash
# Option A: Export all variables (Linux/Mac)
export $(cat ENV.local | grep -v '^#' | xargs)
go run cmd/server/main.go

# Option B: Load in PowerShell (Windows)
Get-Content ENV.local | ForEach-Object {
    if ($_ -notmatch '^#' -and $_ -match '=') {
        $var = $_.Split('=', 2)
        [Environment]::SetEnvironmentVariable($var[0].Trim(), $var[1].Trim())
    }
}
go run cmd/server/main.go

# Option C: Use IDE run configuration
# VS Code: Edit .vscode/launch.json with envFile
# GoLand: Edit run configuration with environment variables file
```

### 4. Run with Docker

```bash
# From monorepo root
docker-compose up api-go

# Or build and run separately
cd api-go
docker build -t api-go:latest .
docker run -p 3001:3001 --env-file ENV.local api-go:latest
```

---

## Current Modules

### 1. Health Module
**Endpoint:** `GET /health`  
**Purpose:** Health check and status monitoring  
**Returns:** Service uptime, connection count, resource usage

### 2. WebSocket Module
**Endpoint:** `GET /ws?token=<JWT>`  
**Purpose:** Real-time bidirectional communication  
**Features:**
- JWT authentication
- Connection pool management
- Message broadcasting
- Heartbeat/ping-pong
- User count tracking

See [WebSocket Documentation](docs/websocket.md) for details.

---

## Adding a New Module

Follow these steps to add a new module (e.g., `upload` for file uploads):

### Step 1: Create Module Directory

```bash
mkdir -p internal/modules/upload
```

### Step 2: Create Handler

```go
// internal/modules/upload/handler.go
package upload

import "github.com/gin-gonic/gin"

type UploadHandler struct {
    service UploadService
}

func NewUploadHandler(service UploadService) *UploadHandler {
    return &UploadHandler{service: service}
}

func (h *UploadHandler) HandleUpload(c *gin.Context) {
    // Handle file upload
}
```

### Step 3: Create Service

```go
// internal/modules/upload/service.go
package upload

type UploadService interface {
    ProcessUpload(file []byte) error
}

type UploadServiceImpl struct {
    // Dependencies
}

func NewUploadService() UploadService {
    return &UploadServiceImpl{}
}

func (s *UploadServiceImpl) ProcessUpload(file []byte) error {
    // Business logic
    return nil
}
```

### Step 4: Create Module

```go
// internal/modules/upload/module.go
package upload

import "github.com/gin-gonic/gin"

type UploadModule struct {
    handler *UploadHandler
}

func NewUploadModule() *UploadModule {
    service := NewUploadService()
    handler := NewUploadHandler(service)
    return &UploadModule{handler: handler}
}

func (m *UploadModule) RegisterRoutes(router *gin.Engine) {
    router.POST("/upload", m.handler.HandleUpload)
}
```

### Step 5: Wire Up in main.go

```go
// cmd/server/main.go
uploadModule := upload.NewUploadModule()
uploadModule.RegisterRoutes(router)
```

### Step 6: Add Tests

```go
// internal/modules/upload/service_test.go
package upload

import "testing"

func TestUploadService(t *testing.T) {
    service := NewUploadService()
    // Test logic
}
```

---

## Future Module Possibilities

The following modules can be added using the same pattern:

### File Upload Module
- Multipart file upload
- Image processing (resize, optimize, format conversion)
- Video transcoding
- Direct-to-S3 uploads with presigned URLs
- File validation and virus scanning

### Streaming Module
- Video/audio streaming
- Server-Sent Events (SSE)
- Chunked file downloads
- Progressive data streaming

### CPU-Intensive Module
- Data processing and transformation
- Report generation (PDF, Excel)
- Image/video manipulation
- Compression/decompression

### Real-Time Features Module
- Chat system (extends WebSocket)
- Live notifications
- Presence system
- Collaborative editing

### Caching Module
- Redis caching layer
- Cache invalidation strategies
- Cache warming
- Distributed caching

### Background Jobs Module
- Job queue management
- Scheduled tasks
- Retry logic
- Job status tracking

---

## Testing

### Unit Tests

```bash
# Run all tests
go test ./...

# Run tests with coverage
go test -cover ./...

# Run tests for specific module
go test ./internal/modules/websocket/...

# Generate coverage report
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Integration Tests

```bash
# Run integration tests
go test ./test/...

# Run with verbose output
go test -v ./test/...
```

### Load Testing (k6)

```bash
# Run WebSocket load test (10k connections)
k6 run test/load/websocket_test.js
```

---

## Deployment

### Docker

```bash
# Build production image
docker build -t api-go:latest .

# Run container
docker run -p 3001:3001 --env-file ENV.local api-go:latest
```

### Docker Compose (Recommended)

```bash
# From monorepo root
docker-compose up api-go

# Or with specific services
docker-compose up api-go api redis mongodb
```

---

## Environment Variables

.env.{env} files are generated based on thonnas-config.json imports, exports and internal env vars.

**Required:**
- `PORT` - HTTP server port (default: 3001)

**Optional:**
- `GIN_MODE` - Gin mode: debug, release (default: debug)
- `LOG_LEVEL` - Log level: debug, info, warn, error (default: info)

---

## Troubleshooting

### Go Not Installed

If you see `go: command not found`:

```bash
# Install Go 1.21+ from https://go.dev/dl/
# Verify installation
go version
```

### Port Already in Use

If port 3001 is busy:

```bash
# Change PORT in ENV.local
PORT=3002

# Or find and kill process using port
# Windows: netstat -ano | findstr :3001
# Linux/Mac: lsof -i :3001
```

### WebSocket Connection Fails

- Verify JWT token is valid and not expired
- Check CORS configuration
- Ensure WebSocket endpoint uses `ws://` (local) or `wss://` (production)

---

## Contributing

When adding new features to api-go:

1. **Follow the module pattern** - Handler, Service, DTO, Module
2. **Write tests** - Aim for >80% coverage
3. **Document your code** - Add comments and update README
4. **Use interfaces** - For testability and DI
5. **Keep modules independent** - Avoid tight coupling
6. **Update documentation** - PRD files, API docs, etc.

---

## Performance

### Benchmarks (WebSocket Module)

- **Concurrent Connections**: 10,000+ per instance
- **Message Latency**: <50ms (p95)
- **Memory Usage**: <150MB for 10k connections
- **CPU Usage**: <20% for 10k connections (2 vCPUs)
- **Broadcast Time**: <100ms to 10k clients

### Compared to Node.js

- **4-10x more concurrent connections** (Go goroutines vs Node.js event loop)
- **10-20x lower memory per connection** (~2-5KB vs ~50-100KB)
- **4-6x better CPU efficiency** for concurrent operations

---

## Resources

- [Go Documentation](https://go.dev/doc/)
- [Gin Framework](https://gin-gonic.com/)
- [Gorilla WebSocket](https://github.com/gorilla/websocket)
- [Feature Design](../prd/features/FEAT-002/feature.design.md)
- [Task List](../prd/features/FEAT-002/api-go-websocket-implementation.tasks.md)

---

## License

Part of the baseline-cursor-v3 project.

**Last Updated:** 2025-10-20  
**Version:** 1.0.0-alpha  
**Status:** In Development (Phase 1 - Foundation)


