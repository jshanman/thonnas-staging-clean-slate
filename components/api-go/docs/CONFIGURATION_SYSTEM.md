# api-go Configuration System

api-go uses build-time configuration generation. JSON configuration is merged,
converted into Go structs, and compiled into the binary. Runtime environment
variables can still override selected values and secrets.

## Source vs Generated Files

| Path | Role | Edit? | Committed? |
|------|------|-------|------------|
| `thonnas-config.json` | Component app defaults and Thonnas exports/imports | Yes | Yes |
| `internal/modules/*/thonnas-config.json` | Module defaults (installed inline) | Yes | With module |
| `scripts/aggregate-configs.go` | Discovers modules, generates env layers + Go config | Yes | Yes |
| `scripts/env-layer-generator.go` | Env-layer profile logic (development/beta/…) | Yes | Yes |
| `config/*.thonnas-config.json` | Generated env-layer merge inputs | No | No (gitignored) |
| `internal/config/generated.go` | Type-safe merged config compiled into the binary | No | No (gitignored) |
| `thonnas-config.generated.json` | Merged Thonnas config for cross-component tooling | No | No (gitignored) |

**Build timing:** `@thonnas/api-go` ships as a baseline component (no modules). After
`thonnas install` and any module installs, **`thonnas build`** runs
`scripts/build.sh`, which executes `aggregate-configs.go` against the **currently
installed** `internal/modules/*` tree, writes gitignored `config/*.thonnas-config.json`,
then emits `internal/config/generated.go` before `go build`.

Project-level `.env.{environment}` files from `thonnas config resolve` are separate
from component env-layer JSON. Resolve materializes exports/imports at the project
root; runtime env vars still override generated defaults via Layer 4.

## Layers

Configuration is merged in this order:

1. Component app defaults from `thonnas-config.json`.
2. Optional module defaults discovered from `internal/modules/*/thonnas-config.json`.
3. Shared defaults from `config/default.thonnas-config.json`.
4. Environment files from `config/{environment}.thonnas-config.json`.
5. Runtime environment variable overrides.

The generated output is `internal/config/generated.go`.

## Build Flow

```text
thonnas-config.json
  + internal/modules/*/thonnas-config.json
  + config/default.thonnas-config.json
  + config/{environment}.thonnas-config.json
        |
        v
scripts/aggregate-configs.go
        |
        v
internal/config/generated.go
```

## Runtime Selection

`GO_ENV` selects the pre-merged environment:

```bash
GO_ENV=development ./bin/server
GO_ENV=beta ./bin/server
GO_ENV=production ./bin/server
GO_ENV=test ./bin/server
```

If `GO_ENV` is unset, development config is used.

## App Config Access

```go
cfg, err := config.Load()
if err != nil {
	return err
}

port := cfg.Port()
environment := cfg.Environment()
logLevel := cfg.Loglevel()
jwtSecret := cfg.Jwtsecret()
```

Secrets are read from environment variables at runtime and are never baked into
generated config values.

## Adding Module Config

Optional modules may add `thonnas-config.json` files:

```json
{
  "config": {
    "example": {
      "enabled": true,
      "timeout": "5s"
    }
  },
  "exports": [
    { "name": "EXAMPLE_ENABLED", "selfImportPath": "example.enabled" },
    { "name": "EXAMPLE_TIMEOUT", "selfImportPath": "example.timeout" }
  ]
}
```

Regenerate after module or config JSON changes:

```bash
# Preferred: full component build (deps + config + compile)
bash scripts/build.sh

# Config generation only
make config-aggregate
```

## Generated Code

The generated file contains:

- `AppConfig` and optional module config structs.
- Pre-merged environment configs.
- `Load()` and `applyEnvOverrides()`.
- Convenience getters for app and module config.
- Secret getters that read environment variables at runtime.

## Validation

After configuration changes, run:

```bash
go run scripts/aggregate-configs.go
go build ./...
go test ./...
```

## Troubleshooting

- If a value is stale, rerun `make config-aggregate`.
- If an environment variable is ignored, check the export or internal mapping in
  the relevant config JSON.
- If generated code fails to compile, inspect the generated file and the JSON
  value that produced the failing field.


