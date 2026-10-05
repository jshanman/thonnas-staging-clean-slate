package appmodule

import (
	thonnashealth "thonnas/api-go/internal/common/thonnas/health"
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/config"
	"thonnas/api-go/internal/thonnas/contracts"

	"github.com/gin-gonic/gin"
)

// healthBuildData stores infrastructure for wire phase
type healthBuildData struct {
	cfg            *config.Config
	log            *logger.Logger
	thonnasMetrics contracts.ThonnasMetrics
	thonnasHealth  contracts.ThonnasHealth
}

// BuildHealthModule is called during the Build phase for common/thonnas/health HTTP routes.
func BuildHealthModule(ctx *BuildContext) (*BuildResult, error) {
	buildData := &healthBuildData{
		cfg:            ctx.Config.(*config.Config),
		log:            ctx.Logger.(*logger.Logger),
		thonnasMetrics: ctx.Contracts.ThonnasMetrics,
		thonnasHealth:  ctx.Contracts.ThonnasHealth,
	}

	return &BuildResult{
		PartialModule: buildData,
		Exports:       make(map[string]interface{}),
	}, nil
}

// WireHealthModule is called during the Wire phase
func WireHealthModule(buildResult *BuildResult, deps ModuleDependencies) (Module, error) {
	buildData := buildResult.PartialModule.(*healthBuildData)

	module := thonnashealth.NewHealthModule(buildData.log, buildData.thonnasMetrics, buildData.thonnasHealth)

	return &HealthModuleAdapter{
		BaseModule: BaseModule{Name: "health"},
		module:     module,
	}, nil
}

// HealthModuleAdapter adapts the health package module to the Module interface
type HealthModuleAdapter struct {
	BaseModule
	module *thonnashealth.HealthModule
}

// RegisterRoutes registers HTTP routes for the health module
func (m *HealthModuleAdapter) RegisterRoutes(router *gin.Engine) error {
	m.module.RegisterRoutes(router)
	return nil
}

