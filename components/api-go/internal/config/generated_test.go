package config_test

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"thonnas/api-go/internal/config"
)

// TestConfigLoads validates the config loading mechanism works
func TestConfigLoads(t *testing.T) {
	clearConfigEnvVars(t)

	cfg, err := config.Load()
	require.NoError(t, err, "Config should load successfully")
	require.NotNil(t, cfg, "Config should not be nil")
	require.NotNil(t, cfg.App, "App config should not be nil")
}

// TestEnvironmentSelection validates GO_ENV selects the correct environment config
func TestEnvironmentSelection(t *testing.T) {
	environments := []string{"development", "staging", "production", "test"}

	for _, env := range environments {
		t.Run("GO_ENV="+env, func(t *testing.T) {
			clearConfigEnvVars(t)
			os.Setenv("GO_ENV", env)
			defer os.Unsetenv("GO_ENV")

			cfg, err := config.Load()
			require.NoError(t, err, "Config should load for %s environment", env)
			require.NotNil(t, cfg)
		})
	}
}

// TestDefaultEnvironment validates development is default when GO_ENV is not set
func TestDefaultEnvironment(t *testing.T) {
	clearConfigEnvVars(t)
	// GO_ENV not set - should default to development

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "development", cfg.App.Environment)
}

// TestInvalidEnvironmentFallback validates fallback to development for unknown GO_ENV
func TestInvalidEnvironmentFallback(t *testing.T) {
	clearConfigEnvVars(t)
	os.Setenv("GO_ENV", "invalid-environment")
	defer os.Unsetenv("GO_ENV")

	cfg, err := config.Load()
	require.NoError(t, err, "Should not error on invalid environment")
	require.NotNil(t, cfg)
	// GO_ENV overrides Environment field (env var takes precedence)
	assert.Equal(t, "invalid-environment", cfg.App.Environment)
	// But config structure uses development defaults
	assert.Equal(t, "debug", cfg.App.Ginmode, "Should fallback to development config structure")
}

// TestAppLevelEnvVarOverrides validates app-level env vars override config
func TestAppLevelEnvVarOverrides(t *testing.T) {
	tests := []struct {
		name     string
		envVar   string
		value    string
		validate func(t *testing.T, cfg *config.Config)
	}{
		{
			name:   "API_GO_INTERNAL_PORT override",
			envVar: "API_GO_INTERNAL_PORT",
			value:  "9999",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "9999", cfg.App.Port)
			},
		},
		{
			name:   "LOG_LEVEL override",
			envVar: "LOG_LEVEL",
			value:  "trace",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "trace", cfg.App.Loglevel)
			},
		},
		{
			name:   "GIN_MODE override",
			envVar: "GIN_MODE",
			value:  "release",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "release", cfg.App.Ginmode)
			},
		},
		{
			name:   "LOG_FORMAT override",
			envVar: "LOG_FORMAT",
			value:  "text",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "text", cfg.App.Logformat)
			},
		},
		{
			name:   "SECRET__API_GO_JWT_SECRET override",
			envVar: "SECRET__API_GO_JWT_SECRET",
			value:  "test-secret-value",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "test-secret-value", cfg.Jwtsecret())
			},
		},
		{
			name:   "SECRET__API_GO_INTERNAL_API_KEY override",
			envVar: "SECRET__API_GO_INTERNAL_API_KEY",
			value:  "test-api-key",
			validate: func(t *testing.T, cfg *config.Config) {
				assert.Equal(t, "test-api-key", cfg.Internalapikey())
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearConfigEnvVars(t)
			os.Setenv("GO_ENV", "development")
			defer os.Unsetenv("GO_ENV")

			os.Setenv(tt.envVar, tt.value)
			defer os.Unsetenv(tt.envVar)

			cfg, err := config.Load()
			require.NoError(t, err)
			tt.validate(t, cfg)
		})
	}
}

// TestEnvVarPrecedenceOverEnvironmentConfig validates env vars override env-specific config
func TestEnvVarPrecedenceOverEnvironmentConfig(t *testing.T) {
	clearConfigEnvVars(t)

	// Production has LOG_LEVEL=warn by default
	os.Setenv("GO_ENV", "production")
	defer os.Unsetenv("GO_ENV")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "warn", cfg.App.Loglevel, "Production should have warn log level")

	// Now override with env var
	os.Setenv("LOG_LEVEL", "debug")
	defer os.Unsetenv("LOG_LEVEL")

	cfg, err = config.Load()
	require.NoError(t, err)
	assert.Equal(t, "debug", cfg.App.Loglevel, "Env var should override production config")
}

// TestConvenienceGetters validates getter methods return correct values
func TestConvenienceGetters(t *testing.T) {
	clearConfigEnvVars(t)
	os.Setenv("GO_ENV", "development")
	defer os.Unsetenv("GO_ENV")

	cfg, err := config.Load()
	require.NoError(t, err)

	// Verify getters match struct values
	assert.Equal(t, cfg.App.Port, cfg.Port())
	assert.Equal(t, cfg.App.Environment, cfg.Environment())
	assert.Equal(t, cfg.App.Loglevel, cfg.Loglevel())
	assert.Equal(t, cfg.App.Ginmode, cfg.Ginmode())
}

func TestDevelopmentEnvLayerValues(t *testing.T) {
	clearConfigEnvVars(t)
	os.Setenv("GO_ENV", "development")
	defer os.Unsetenv("GO_ENV")

	cfg, err := config.Load()
	require.NoError(t, err)
	assert.Equal(t, "3001", cfg.Port())
	assert.Equal(t, "localhost", cfg.GetTmMqttConfig().Brokerhost)
}

// TestEnvironmentSpecificValues validates environments have different values
func TestEnvironmentSpecificValues(t *testing.T) {
	clearConfigEnvVars(t)

	// Load development
	os.Setenv("GO_ENV", "development")
	devCfg, err := config.Load()
	require.NoError(t, err)
	os.Unsetenv("GO_ENV")

	// Load production
	os.Setenv("GO_ENV", "production")
	prodCfg, err := config.Load()
	require.NoError(t, err)
	os.Unsetenv("GO_ENV")

	// Verify they have different values (mechanism works)
	assert.NotEqual(t, devCfg.App.Loglevel, prodCfg.App.Loglevel, "Log levels should differ between envs")
	assert.NotEqual(t, devCfg.App.Ginmode, prodCfg.App.Ginmode, "Gin modes should differ between envs")
}

// TestMultipleEnvVarsOverride validates multiple env vars can be set simultaneously
func TestMultipleEnvVarsOverride(t *testing.T) {
	clearConfigEnvVars(t)
	os.Setenv("GO_ENV", "development")
	defer os.Unsetenv("GO_ENV")

	// Set multiple env vars
	os.Setenv("API_GO_INTERNAL_PORT", "8080")
	os.Setenv("LOG_LEVEL", "error")
	os.Setenv("GIN_MODE", "test")
	os.Setenv("SECRET__API_GO_JWT_SECRET", "multi-test-secret")
	defer os.Unsetenv("API_GO_INTERNAL_PORT")
	defer os.Unsetenv("LOG_LEVEL")
	defer os.Unsetenv("GIN_MODE")
	defer os.Unsetenv("SECRET__API_GO_JWT_SECRET")

	cfg, err := config.Load()
	require.NoError(t, err)

	assert.Equal(t, "8080", cfg.App.Port)
	assert.Equal(t, "error", cfg.App.Loglevel)
	assert.Equal(t, "test", cfg.App.Ginmode)
	assert.Equal(t, "multi-test-secret", cfg.Jwtsecret())
}

// clearConfigEnvVars clears app-level config environment variables
func clearConfigEnvVars(t *testing.T) {
	t.Helper()

	envVars := []string{
		// App-level internal env vars
		"GO_ENV", "GIN_MODE", "LOG_LEVEL", "LOG_FORMAT", "OTEL_EXPORTER_OTLP_ENDPOINT",
		// App-level exports
		"API_GO_INTERNAL_PORT", "API_GO_INTERNAL_HOST", "API_GO_INTERNAL_URL",
		// Secret exports (with and without SECRET__ prefix)
		"SECRET__API_GO_JWT_SECRET", "API_GO_JWT_SECRET",
		"SECRET__API_GO_INTERNAL_API_KEY", "API_GO_INTERNAL_API_KEY",
		// Secret imports
		"SECRET__CACHE_REDIS_PASSWORD", "CACHE_REDIS_PASSWORD",
	}

	for _, env := range envVars {
		os.Unsetenv(env)
	}
}

