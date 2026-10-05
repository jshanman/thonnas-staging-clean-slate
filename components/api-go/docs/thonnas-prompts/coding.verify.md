# api-go: Verification Checklist

Verify the Go API builds, passes tests, starts correctly, and serves healthy responses.

## Static checks

### Dependencies and Build

cd components/api-go && go mod download && go build ./...

- [ ] `go mod download` completes without errors
- [ ] `go build ./...` compiles all packages with no errors
- [ ] No unused imports or variables (Go compiler enforces this)

### Linting

cd components/api-go && go vet ./...

- [ ] `go vet` reports no issues
- [ ] No suspicious constructs detected

### Unit Tests

cd components/api-go && go test -v ./...

- [ ] All existing tests pass
- [ ] New tests added for new code
- [ ] No test timeouts or race conditions

### Module-Specific Unit Tests

For each affected module:

cd components/api-go && go test -v ./internal/modules/{module-name}/...

- [ ] Module tests pass in isolation

## Runtime checks

### Docker Build and Startup

docker compose build api-go
docker compose up -d api-go

- [ ] Docker image builds successfully
- [ ] Container starts without crash loops
- [ ] Logs show successful startup

### Module-Specific Runtime Checks

For each affected module, verify endpoints:

## Troubleshooting

### Common Build Failures

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `cannot find module` | Missing dependency | Run `go mod tidy` |
| `undefined:` symbol | Missing import or wrong package | Check import paths |
| `too many arguments` | Function signature mismatch | Verify interface implementation |

### Common Runtime Failures

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| Container exits immediately | Missing env vars | Check `docker compose logs api-go` |
| Connection refused | Wrong port or not started | Verify port config and healthcheck |
