# api-go Setup Guide

## Prerequisites Installation

### 1. Install Go

api-go requires **Go 1.21 or later**.

#### Windows

**Option A: Official Installer (Recommended)**
1. Download from: https://go.dev/dl/
2. Download `go1.21.x.windows-amd64.msi`
3. Run installer, follow prompts
4. Verify installation:
   ```powershell
   go version
   # Should output: go version go1.21.x windows/amd64
   ```

**Option B: Chocolatey**
```powershell
choco install golang
```

#### macOS

**Option A: Homebrew (Recommended)**
```bash
brew install go
```

**Option B: Official Installer**
1. Download from: https://go.dev/dl/
2. Download `.pkg` file
3. Run installer

#### Linux

**Option A: Official Tarball**
```bash
# Download and extract
wget https://go.dev/dl/go1.21.x.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.21.x.linux-amd64.tar.gz

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH=$PATH:/usr/local/go/bin
```

**Option B: Package Manager**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install golang-go

# Fedora
sudo dnf install golang

# Arch
sudo pacman -S go
```

### 2. Verify Go Installation

```bash
# Check version
go version

# Check environment
go env

# Verify GOPATH is set
echo $GOPATH  # Unix/Mac
echo $env:GOPATH  # Windows PowerShell
```

---

## Initial Setup

### 1. Install Dependencies

```bash
cd api-go

# Merge installed module go.mod.fragment files (when present), then refresh go.sum
bash scripts/setup.sh
```

`thonnas setup` runs the same script when preparing the component.

### 2. Configure Environment

```bash
# ENV.local should already exist (copied from ENV.local.example)
# Verify JWT_SECRET matches api/ENV.local
# Update any other settings as needed
```

**IMPORTANT**: Ensure `JWT_SECRET` in `api-go/ENV.local` **exactly matches** `JWT_SECRET` in `api/ENV.local`. Otherwise, JWT validation will fail.

### 3. Build the Application

```bash
# Build binary
go build -o bin/api-go cmd/server/main.go

# Or run directly without building
go run cmd/server/main.go
```

---

## Running Locally

### Option 1: Go Run (Development)

```bash
cd api-go
go run cmd/server/main.go
```

Server will start on `http://localhost:3001`

- Health check: http://localhost:3001/health
- WebSocket: ws://localhost:3001/ws?token=<JWT>

### Option 2: Docker (Recommended)

From monorepo root:

```bash
# Build and start all services
docker-compose up -d

# Or start just api-go (with dependencies)
docker-compose up api-go

# View logs
docker-compose logs -f api-go

# Check status
docker-compose ps
```

### Option 3: Build Binary

```bash
# Build
cd api-go
go build -o bin/api-go cmd/server/main.go

# Run
./bin/api-go  # Unix/Mac
.\bin\api-go.exe  # Windows

# Or with custom env file
export $(cat ENV.local | xargs) && ./bin/api-go  # Unix/Mac
```

---

## Testing WebSocket Connection

### Using Browser Console

```javascript
// 1. Get JWT token by logging in via web app or API
// 2. Open browser console
const token = "your-jwt-token-here";
const ws = new WebSocket(`ws://localhost:3001/ws?token=${token}`);

ws.onopen = () => console.log('Connected');
ws.onmessage = (event) => console.log('Message:', JSON.parse(event.data));
ws.onerror = (error) => console.error('Error:', error);
ws.onclose = () => console.log('Disconnected');
```

### Using websocat (Command-line)

```bash
# Install websocat
# macOS: brew install websocat
# Linux: Download from https://github.com/vi/websocat/releases

# Connect to WebSocket
websocat "ws://localhost:3001/ws?token=<JWT>"

# You should receive a "connected" message:
# {"type":"connected","payload":{"userId":"xxx","currentUserCount":1},"timestamp":"..."}
```

### Using Postman

1. Create new WebSocket request
2. URL: `ws://localhost:3001/ws?token=<JWT>`
3. Connect
4. View messages in the messages panel

---

## Development Workflow

### Hot Reload (Optional)

Install **air** for automatic reloading:

```bash
# Install air
go install github.com/cosmtrek/air@latest

# Run with hot reload
air

# Or specify config
air -c .air.toml
```

### Running Tests

```bash
# Run all tests
go test ./...

# Run with coverage
go test -cover ./...

# Run specific module tests
go test ./internal/modules/websocket/...

# Run with verbose output
go test -v ./...

# Generate HTML coverage report
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Code Formatting

```bash
# Format all Go files
go fmt ./...

# Or use gofmt directly
gofmt -w .

# Run linter (requires golangci-lint)
golangci-lint run
```

---

## Troubleshooting

### "go: command not found"

Go is not installed or not in PATH.

**Solution:**
1. Install Go from https://go.dev/dl/
2. Verify installation: `go version`
3. If still not found, add Go to PATH

### "cannot find module"

Dependencies not downloaded.

**Solution:**
```bash
cd api-go
go mod download
go mod tidy
```

### Port 3001 already in use

Another service is using port 3001.

**Solution:**
```bash
# Change PORT in ENV.local to a different port (e.g., 3002)
PORT=3002

# Or find and stop the conflicting process
# Windows
netstat -ano | findstr :3001

# Linux/Mac  
lsof -i :3001
```

### WebSocket upgrade fails with 401

JWT token is invalid, expired, or JWT_SECRET mismatch.

**Solution:**
1. Verify JWT_SECRET matches between api and api-go ENV.local files
2. Get a fresh JWT token by logging in via the API
3. Check token expiration

### Docker build fails

Go dependencies not accessible or build context issues.

**Solution:**
```bash
# Clear Docker cache
docker-compose build --no-cache api-go

# Or build manually
cd api-go
docker build --no-cache -t api-go:latest .
```

---

## Next Steps

After completing Phase 1 foundation:

1. **Implement WebSocket connection lifecycle** (Phase 2)
2. **Add message broadcasting** (Phase 3)
3. **Implement user count feature** (Phase 4)
4. **Add Angular WebSocket client** (web component)
5. **Add Flutter WebSocket client** (mobile component)
6. **Load testing** (k6, 10k+ connections)

See [Task List](../prd/features/FEAT-002/api-go-websocket-implementation.tasks.md) for complete implementation plan.

---

## Resources

- [Go Documentation](https://go.dev/doc/)
- [Go Tour (Interactive Learning)](https://go.dev/tour/)
- [Gin Framework Docs](https://gin-gonic.com/docs/)
- [Gorilla WebSocket Docs](https://pkg.go.dev/github.com/gorilla/websocket)
- [Feature Design](../prd/features/FEAT-002/feature.design.md)




