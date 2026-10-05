# Multi-stage Dockerfile for api-go
# Stage 1: Builder - Build the Go application
# Stage 2: Production - Minimal runtime image

#########################################
# Stage 1: Builder
#########################################
FROM golang:1.24-alpine AS builder

# Install build dependencies
# @intent Install bash for scripts/run-aggregate-configs.sh (Alpine ships sh only)
RUN apk add --no-cache git ca-certificates bash

# Set working directory
WORKDIR /app

# Copy go mod baseline and module dependency fragments
COPY go.mod go.sum ./
COPY scripts/aggregate-go-deps.go ./scripts/
COPY internal/modules/ ./internal/modules/

# Merge module go.mod.fragment files into root go.mod, then download dependencies
RUN go run scripts/aggregate-go-deps.go && go mod tidy && go mod download

# Copy remaining source code
COPY . .

# Aggregate configurations (generates internal/config/generated.go)
RUN bash scripts/run-aggregate-configs.sh

# Build the application
# CGO_ENABLED=0 for static binary (no C dependencies)
# -ldflags="-w -s" strips debug info (smaller binary)
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-w -s" \
    -o /app/bin/api-go \
    ./cmd/server/main.go

#########################################
# Stage 2: Development
#########################################
FROM golang:1.24-alpine AS development

# Install development dependencies
# @intent Install bash for scripts/run-aggregate-configs.sh (Alpine ships sh only)
RUN apk add --no-cache git ca-certificates bash

# Set working directory
WORKDIR /app

# Copy go mod baseline and module dependency fragments
COPY go.mod go.sum ./
COPY scripts/aggregate-go-deps.go ./scripts/
COPY internal/modules/ ./internal/modules/

# Merge module go.mod.fragment files into root go.mod, then download dependencies
RUN go run scripts/aggregate-go-deps.go && go mod tidy && go mod download

# Install air for hot reloading (compatible with Go 1.24)
RUN go install github.com/air-verse/air@v1.62.0

# Create tmp directory for air builds
RUN mkdir -p /app/tmp

# Copy air configuration
COPY .air.toml ./

# Copy thonnas metadata and scripts (aggregate-configs generates config/ at build time)
COPY thonnas-config.json ./
COPY thonnas-secrets.json ./

# Copy source code (excluding vendor directory and other build artifacts)
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY scripts/ ./scripts/

# Aggregate module configurations and generate type-safe code
# Generates gitignored config/*.thonnas-config.json and internal/config/generated.go
RUN bash scripts/run-aggregate-configs.sh

# Expose ports
EXPOSE 3001 9090

# Use air for hot reloading in development
# Note: Source code should be mounted as volume
# Run config aggregation before starting air (in case configs changed)
CMD ["sh", "-c", "go run scripts/aggregate-go-deps.go && go mod tidy && bash scripts/run-aggregate-configs.sh && air -c .air.toml"]

#########################################
# Stage 3: Production
#########################################
FROM alpine:latest AS production

# Install runtime dependencies
RUN apk --no-cache add ca-certificates tzdata

# Create non-root user for security
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# Set working directory
WORKDIR /app

# Create config directory
RUN mkdir -p config

# Copy binary from builder
COPY --from=builder /app/bin/api-go .

# Config is baked into binary via internal/config/generated.go (env at runtime). No yaml files required.

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Run the application
CMD ["./api-go"]

# @intent Provide runtime aliases so THONNAS_ENV=beta/release/prod reuse the hardened production image
FROM production AS beta
FROM production AS release
FROM production AS prod




