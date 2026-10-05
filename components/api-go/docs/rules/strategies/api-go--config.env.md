# Strategy Implementation: config.env

**Component/Module:** api-go  
**Strategy:** `config.env`  
**Category:** config  
**Purpose:** Environment configuration

---

## Implementation Approach

api-go generates type-safe Go configuration from Thonnas JSON config files at
build time. Runtime environment variables override selected values and provide
secrets.

## Technology Stack

- **Generator:** `scripts/aggregate-configs.go`
- **Generated output:** `internal/config/generated.go`
- **Runtime selection:** `GO_ENV`
- **Secret access:** generated getters that read environment variables

## Code Pattern

```go
cfg, err := config.Load()
if err != nil {
	return err
}

port := cfg.Port()
logLevel := cfg.Loglevel()
jwtSecret := cfg.Jwtsecret()
```

## Environment Variables

```bash
GO_ENV=development
API_GO_INTERNAL_PORT=3001
GIN_MODE=debug
LOG_LEVEL=info
METRICS_OTEL_GRPC_ENDPOINT=localhost:4317
API_GO_JWT_SECRET=change-this-in-production
```

## Best Practices

- Keep secrets out of config files.
- Regenerate config after changing any `thonnas-config.json` file.
- Prefer generated getters and struct fields over manual environment parsing.
- Validate critical settings during startup.

## Testing

- Load each supported `GO_ENV`.
- Verify environment overrides are applied.
- Verify secret getters read runtime environment variables.
- Run `go build ./...` after regenerating config.

## Related Strategies

- [`auth.jwt`](api-go--auth.jwt.md)


