package tmmqtt

import (
	"context"

	"thonnas/api-go/internal/appmodule"
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/config"

	"github.com/patrickmn/go-cache"
)

// BuildMQTTModule is called during the Build phase
func BuildMQTTModule(ctx *appmodule.BuildContext) (*appmodule.BuildResult, error) {
	cfg := ctx.Config.(*config.Config)
	log := ctx.Logger.(*logger.Logger)
	cache := ctx.Cache.(*cache.Cache)

	// @intent Forward MQTT broadcasts through portable ThonnasMetrics (SigNoz wiring is component-level)
	RegisterMetricsBridge(ctx.Contracts.ThonnasMetrics)

	// Create MQTT module during build phase
	// This is necessary because usercount needs to register handlers before MQTT starts
	module, err := NewModule(log, cfg, cache)
	if err != nil {
		return nil, err
	}

	exports := map[string]interface{}{
		"client": module.GetClient(),
		"module": module,
	}

	return &appmodule.BuildResult{
		PartialModule: module,
		Exports:       exports,
	}, nil
}

// WireMQTTModule is called during the Wire phase
func WireMQTTModule(buildResult *appmodule.BuildResult, deps appmodule.ModuleDependencies) (appmodule.Module, error) {
	module := buildResult.PartialModule.(*Module)

	return &MQTTModuleAdapter{
		module: module,
		BaseModule: appmodule.BaseModule{
			Name: "mqtt",
		},
	}, nil
}

// MQTTModuleAdapter adapts the MQTT module to the appmodule.Module interface
type MQTTModuleAdapter struct {
	appmodule.BaseModule
	module *Module
}

// Start starts the MQTT module
func (m *MQTTModuleAdapter) Start(ctx context.Context) error {
	return m.module.Start(ctx)
}

// Stop stops the MQTT module
func (m *MQTTModuleAdapter) Stop() error {
	return m.module.Stop()
}

// GetExports returns the MQTT client for other modules to use
func (m *MQTTModuleAdapter) GetExports() map[string]interface{} {
	return map[string]interface{}{
		"client": m.module.GetClient(),
		"module": m.module,
	}
}

