.PHONY: help config-aggregate build run dev test clean install-hooks

# Default target
help:
	@echo "🚀 api-go Makefile Commands"
	@echo ""
	@echo "Configuration:"
	@echo "  make config-aggregate  - Aggregate module configurations"
	@echo ""
	@echo "Development:"
	@echo "  make build            - Build the application"
	@echo "  make run              - Run the application"
	@echo "  make dev              - Run with auto-reload (requires air)"
	@echo "  make test             - Run tests"
	@echo ""
	@echo "Setup:"
	@echo "  make install-hooks    - Install git hooks"
	@echo "  make clean            - Clean build artifacts"

# Aggregate module configurations
config-aggregate:
	@echo "📦 Aggregating configurations..."
	@bash scripts/run-aggregate-configs.sh

# Build the application (runs config aggregation first)
build: config-aggregate
	@echo "🔨 Building api-go..."
	@go build -o bin/server cmd/server/main.go
	@echo "✅ Build complete: bin/server"

# Run the application (builds first)
run: build
	@echo "🚀 Starting api-go..."
	@./bin/server

# Development mode with auto-reload (requires air: go install github.com/cosmtrek/air@latest)
dev: config-aggregate
	@echo "🔥 Starting development server with auto-reload..."
	@air

# Run tests (regenerate config first — generated.go is not committed)
test: config-aggregate
	@echo "🧪 Running tests..."
	@go test -v ./...

# Clean build artifacts
clean:
	@echo "🧹 Cleaning build artifacts..."
	@rm -rf bin/
	@rm -f internal/config/generated.go
	@echo "✅ Clean complete"

# Install git hooks
install-hooks:
	@echo "🔧 Installing git hooks..."
	@mkdir -p ../.git/hooks
	@cp .githooks/pre-commit ../.git/hooks/pre-commit
	@chmod +x ../.git/hooks/pre-commit
	@echo "✅ Git hooks installed"


