# api-go Module System

This document describes the lightweight module system used by the standalone
api-go component. The component ships with core application lifecycle support
and an inlined health module. Optional feature modules can be installed later
without changing `cmd/server`.

## Overview

The module system uses a two-phase lifecycle:

1. Build modules without cross-module dependencies.
2. Wire modules in dependency order.
3. Register routes.
4. Start modules.
5. Stop modules in reverse dependency order.

Dependency order is derived from each module's `Imports` list in
`internal/app/modules.go`.

## Layout

```text
internal/
├── app/
│   ├── app.go
│   ├── module.go
│   └── modules.go
├── appmodule/
│   └── module.go
├── common/thonnas/
│   ├── bundle.go
│   ├── resolve.go
│   ├── imports_wiring.go
│   ├── health/
│   ├── logger/
│   ├── metrics/
│   ├── email/
│   └── events/
└── modules/
    └── optional feature packages
```

`internal/common/thonnas` is the shared contracts bundle. It provides portable
interfaces and noop defaults so the standalone component can run without any
optional feature packages installed.

## Core Registry

The standalone extract does not wire any optional feature module by default:

```go
func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{}
}
```

Health support is provided by common Thonnas code and does not require an
optional package under `internal/modules`.

## Adding an Optional Module

Create a package under `internal/modules/{module-name}` with an app adapter:

```go
func BuildExampleModule(ctx *appmodule.BuildContext) (*appmodule.BuildResult, error) {
	return &appmodule.BuildResult{
		PartialModule: nil,
		Exports:       map[string]interface{}{},
	}, nil
}

func WireExampleModule(buildResult *appmodule.BuildResult, deps appmodule.ModuleDependencies) (appmodule.Module, error) {
	return &ExampleModule{
		BaseModule: appmodule.BaseModule{Name: "example"},
	}, nil
}
```

Then add the module to `internal/app/modules.go`:

```go
{
	Name:      "example",
	Imports:   []string{},
	BuildFunc: example.BuildExampleModule,
	WireFunc:  example.WireExampleModule,
}
```

## Dependency Rules

- `Name` must be unique and stable.
- `Imports` contains the `Name` values of other registered modules.
- Circular dependencies fail during startup.
- Modules should expose shared values through `BuildResult.Exports` or
  `GetExports()`.

## Configuration

Module defaults live in `internal/modules/{module-name}/thonnas-config.json`.
After adding or changing module config, regenerate type-safe config:

```bash
make config-aggregate
```

## Validation

After changing module wiring, run:

```bash
go build ./...
go test ./...
```


