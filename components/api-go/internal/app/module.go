package app

// Re-export module interfaces and types from appmodule package
// This avoids import cycles while maintaining the app package API

import "thonnas/api-go/internal/appmodule"

// Module interfaces and types (re-exported from appmodule)
type (
	Module             = appmodule.Module
	BaseModule         = appmodule.BaseModule
	ModuleMetadata     = appmodule.ModuleMetadata
	BuildContext       = appmodule.BuildContext
	BuildResult        = appmodule.BuildResult
	ModuleDependencies = appmodule.ModuleDependencies
	BuildModuleFunc    = appmodule.BuildModuleFunc
	WireModuleFunc     = appmodule.WireModuleFunc
)

