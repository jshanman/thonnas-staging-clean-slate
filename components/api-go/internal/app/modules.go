package app

import (
	"thonnas/api-go/internal/appmodule"
)

// GetModuleMetadata returns all module definitions for the application
// This is the central module registry (like NestJS @Module imports array)
//
// To add a new module:
// 1. Implement the module (often as a published @thonnas package or local package) with app_adapter.go (Build*/Wire*)
// 2. Add the module entry to this list with correct Imports for dependency order
//
// The order doesn't matter - dependency resolution is automatic via the Imports field
func GetModuleMetadata() []*ModuleMetadata {
	return []*ModuleMetadata{
		// Health (inlined common/thonnas/health) — no dependencies
		{
			Name:      "health",
			Imports:   []string{},
			BuildFunc: appmodule.BuildHealthModule,
			WireFunc:  appmodule.WireHealthModule,
		},
	}
}

