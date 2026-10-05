package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// @intent Emit gitignored env-layer JSON during thonnas build (app profiles; module defaults from thonnas-config)
func writeGeneratedEnvLayerFiles(_ map[string]ModuleConfig) error {
	if err := os.MkdirAll("config", 0755); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}

	files := map[string]map[string]interface{}{
		"default.thonnas-config.json":     defaultEnvLayer(),
		"development.thonnas-config.json": developmentEnvLayer(),
		"beta.thonnas-config.json":        betaEnvLayer(),
		"staging.thonnas-config.json":     stagingEnvLayer(),
		"production.thonnas-config.json":  productionEnvLayer(),
		"test.thonnas-config.json":        testEnvLayer(),
	}

	for name, payload := range files {
		path := filepath.Join("config", name)
		data, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal %s: %w", name, err)
		}
		data = append(data, '\n')
		if err := os.WriteFile(path, data, 0644); err != nil {
			return fmt.Errorf("write %s: %w", name, err)
		}
		fmt.Printf("  ✅ Generated %s\n", path)
	}

	return nil
}

func defaultEnvLayer() map[string]interface{} {
	return envLayerDoc(nil, nil)
}

func developmentEnvLayer() map[string]interface{} {
	return envLayerDoc(map[string]interface{}{
		"ginMode":      "debug",
		"logLevel":     "debug",
		"environment":  "development",
		"port":         "3001",
		"otelEndpoint": "localhost:4317",
	}, nil)
}

func betaEnvLayer() map[string]interface{} {
	return envLayerDoc(map[string]interface{}{
		"ginMode":      "release",
		"logLevel":     "info",
		"environment":  "staging",
		"port":         "3001",
		"otelEndpoint": "signoz:4317",
		"corsAllowedOrigins": []interface{}{
			"https://staging.example.com",
			"http://localhost:4200",
		},
	}, nil)
}

func stagingEnvLayer() map[string]interface{} {
	return envLayerDoc(map[string]interface{}{
		"ginMode":      "release",
		"logLevel":     "info",
		"environment":  "staging",
		"port":         "3001",
		"otelEndpoint": "signoz:4317",
		"corsAllowedOrigins": []interface{}{
			"https://staging.example.com",
			"http://localhost:4200",
		},
	}, nil)
}

func productionEnvLayer() map[string]interface{} {
	return envLayerDoc(map[string]interface{}{
		"ginMode":      "release",
		"logLevel":     "warn",
		"environment":  "production",
		"port":         "3001",
		"otelEndpoint": "signoz:4317",
		"corsAllowedOrigins": []interface{}{
			"https://app.example.com",
			"https://www.example.com",
		},
		"httpReadTimeout":     "30s",
		"httpWriteTimeout":    "30s",
		"httpIdleTimeout":     "120s",
		"httpShutdownTimeout": "60s",
	}, nil)
}

func testEnvLayer() map[string]interface{} {
	return envLayerDoc(map[string]interface{}{
		"ginMode":             "test",
		"logLevel":            "error",
		"environment":         "test",
		"port":                "0",
		"otelEndpoint":        "",
		"metricsEnabled":      false,
		"httpReadTimeout":     "5s",
		"httpWriteTimeout":    "5s",
		"httpIdleTimeout":     "10s",
		"httpShutdownTimeout": "5s",
	}, nil)
}

func envLayerDoc(app map[string]interface{}, modules map[string]interface{}) map[string]interface{} {
	configSection := map[string]interface{}{}
	if len(app) > 0 {
		configSection["app"] = app
	}
	if len(modules) > 0 {
		configSection["modules"] = modules
	}
	return map[string]interface{}{
		"config":  configSection,
		"exports": []interface{}{},
	}
}


