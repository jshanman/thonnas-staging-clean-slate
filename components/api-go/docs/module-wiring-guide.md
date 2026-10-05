# Module Wiring Guide for api-go

This guide helps the AI understand how to wire and unwire Thonnas modules in the api-go component.

## Component Information

- **Component**: api-go
- **Framework**: Gin
- **Language**: Go
- **Wiring File**: `internal/app/modules.go`
- **Module Path**: `internal/modules/`
- **Core types**: `internal/app/module.go` re-exports `appmodule` (`ModuleMetadata`, `BuildModuleFunc`, `WireModuleFunc`, etc.)

## Module Wiring Pattern

Modules use a **central registry** in `GetModuleMetadata()`: each entry is a `*ModuleMetadata` with `Name`, `Imports` (dependency module names), `BuildFunc`, and `WireFunc`. The app runs **Build → Wire → RegisterRoutes → Start** in dependency order (`Imports` drives topological sort).

### 1. Import the module adapter

Add an import for the module’s `app_adapter` package (convention: `internal/modules/tm-{feature}/app_adapter.go`).

```go
import (
	tmhealth "thonnas/api-go/internal/modules/tm-health"
)
```

**Pattern rules**:

- Folder name uses the `tm-` prefix (e.g., `tm-health`, `tm-auth`).
- Import path is `thonnas/api-go/internal/modules/{folder}`.
- Use a **short alias** (`tmhealth`, `tmauth`) to keep `GetModuleMetadata` readable.

### 2. Register in `GetModuleMetadata`

Append a `ModuleMetadata` entry to the slice returned by `GetModuleMetadata()` in `internal/app/modules.go`:

```go
{
	Name:      "{short-name}",       // e.g. "health" — matches what other modules list in Imports
	Imports:   []string{...},        // names of modules this one depends on; empty if none
	BuildFunc: tm{feature}.Build{Feature}Module,
	WireFunc:  tm{feature}.Wire{Feature}Module,
},
```

**Pattern rules**:

- `Name` must be **unique** and stable; other modules refer to it in their `Imports` slice.
- `Imports` lists **only** `Name` values of other registered modules (not import paths).
- `BuildFunc` / `WireFunc` must match `appmodule.BuildModuleFunc` and `appmodule.WireModuleFunc`.
- **Order in the slice does not matter**; the runtime sorts by `Imports`.

**Example** (`tm-health`, no dependencies):

```go
{
	Name:      "health",
	Imports:   []string{},
	BuildFunc: tmhealth.BuildHealthModule,
	WireFunc:  tmhealth.WireHealthModule,
},
```

**Example** (fictional module that depends on `health`):

```go
{
	Name:      "dashboard",
	Imports:   []string{"health"},
	BuildFunc: tmdashboard.BuildDashboardModule,
	WireFunc:  tmdashboard.WireDashboardModule,
},
```

## Module layout (what to create before wiring)

For a new module under `internal/modules/tm-example/`:

1. Implement `appmodule.Module` (often by embedding `appmodule.BaseModule` and overriding hooks).
2. Add **`app_adapter.go`** with:
   - `BuildExampleModule(ctx *appmodule.BuildContext) (*appmodule.BuildResult, error)`
   - `WireExampleModule(buildResult *appmodule.BuildResult, deps appmodule.ModuleDependencies) (appmodule.Module, error)`
3. Register routes in `RegisterRoutes` (or during Wire if appropriate).
4. Export values other modules need via `BuildResult.Exports` / `Module.GetExports()`.

Then wire the module in `modules.go` as in sections 1–2.

## Complete Example

### Before (no tm-health)

```go
package app

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{}
}
```

### After (with tm-health)

```go
package app

import (
	tmhealth "thonnas/api-go/internal/modules/tm-health"
)

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		{
			Name:      "health",
			Imports:   []string{},
			BuildFunc: tmhealth.BuildHealthModule,
			WireFunc:  tmhealth.WireHealthModule,
		},
	}
}
```

## Edge Cases

### Dependency order and cycles

- Dependencies are resolved from `Imports`; do not rely on slice order.
- **Import cycles** between modules (A imports B, B imports A) must be avoided; refactor shared code or use a third module.

### Using dependencies in `WireFunc`

Use `deps.Get("other-module-name", "exportKey")` or `deps.GetRequired(...)` for required exports. Keys must match what the dependency sets in `BuildResult.Exports` or `GetExports()`.

### Build vs Wire

- **Build**: no other modules available; use for cheap setup, registering listeners, preparing partial state.
- **Wire**: full dependency map available; construct the real `Module` and wire cross-module references.

## Common Mistakes to Avoid

1. **Wrong import path**  
   - ❌ `thonnas/api-go/modules/tm-health`  
   - ✅ `thonnas/api-go/internal/modules/tm-health`

2. **Mismatch between `Imports` and `Name`**  
   - ❌ `Imports: []string{"tm-health"}` while the dependency’s `Name` is `"health"`  
   - ✅ Use the exact `Name` field of the dependency module.

3. **Forgetting the import**  
   - ❌ Using `tmhealth.BuildHealthModule` without adding the `import` block.  
   - ✅ Add the aliased import and reference the adapter functions.

4. **Nil or wrong function signatures**  
   - `BuildFunc` / `WireFunc` must match the `appmodule` function types exactly.

## Validation

After wiring or unwiring a module:

1. ✅ `go build ./...` from the `api-go` component root  
2. ✅ `go test ./...`  
3. ✅ Run the server and hit the module’s HTTP routes (if any)  
4. ✅ If the module uses config, run `go run scripts/aggregate-configs.go` (from api-go root) when `thonnas-config` changes, then rebuild
5. ✅ If the module adds third-party Go packages, declare them in `internal/modules/tm-{feature}/go.mod.fragment` and run `bash scripts/setup.sh` (or `thonnas setup`) to merge into root `go.mod`
6. ✅ Installable cache backends patch `cacheConfigEnv` in `internal/common/thonnas/cache/provider.go` and register `thonnascache.CacheProviderBuild` in module `init()`  

---

## Wiring Examples

These examples show how to **add** a module. Used by AI for module installation.

### Basic module (no dependencies)

#### Input

```go
package app

import (
	tmuser "thonnas/api-go/internal/modules/tm-user"
)

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		{
			Name:      "user",
			Imports:   []string{},
			BuildFunc: tmuser.BuildUserModule,
			WireFunc:  tmuser.WireUserModule,
		},
	}
}
```

#### Output

```go
package app

import (
	tmexample "thonnas/api-go/internal/modules/tm-example"
	tmuser    "thonnas/api-go/internal/modules/tm-user"
)

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		{
			Name:      "user",
			Imports:   []string{},
			BuildFunc: tmuser.BuildUserModule,
			WireFunc:  tmuser.WireUserModule,
		},
		{
			Name:      "example",
			Imports:   []string{},
			BuildFunc: tmexample.BuildExampleModule,
			WireFunc:  tmexample.WireExampleModule,
		},
	}
}
```

#### Symbols

- ExampleModule (logical) / `example` as `Name`
- `/tm-example/`
- `app_adapter.go` with `BuildExampleModule`, `WireExampleModule`

#### What changed

Added import alias for `tm-example` and one new `ModuleMetadata` entry.

---

## Unwiring Examples

These examples show how to **remove** a module. Used by AI for module package creation or teardown.

### Basic module

#### Input

```go
package app

import (
	tmexample "thonnas/api-go/internal/modules/tm-example"
	tmuser    "thonnas/api-go/internal/modules/tm-user"
)

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		{
			Name:      "user",
			Imports:   []string{},
			BuildFunc: tmuser.BuildUserModule,
			WireFunc:  tmuser.WireUserModule,
		},
		{
			Name:      "example",
			Imports:   []string{},
			BuildFunc: tmexample.BuildExampleModule,
			WireFunc:  tmexample.WireExampleModule,
		},
	}
}
```

#### Output

```go
package app

import (
	tmuser "thonnas/api-go/internal/modules/tm-user"
)

func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		{
			Name:      "user",
			Imports:   []string{},
			BuildFunc: tmuser.BuildUserModule,
			WireFunc:  tmuser.WireUserModule,
		},
	}
}
```

#### Symbols

- ExampleModule / `example`
- `/tm-example/`
- `app_adapter.go`

#### What changed

Removed the `tm-example` import and the `example` `ModuleMetadata` entry.

### Dependent module (update `Imports` elsewhere)

If another module listed `"example"` in `Imports`, **remove or replace** that string when unwiring `example`, or startup will fail when resolving dependencies.

---

*This guide is used by the Thonnas CLI for AI-assisted module wiring operations.*

