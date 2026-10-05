package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ModuleConfig stores defaults + env variable mapping for a module/app scope
type ModuleConfig struct {
	Config      map[string]interface{}
	EnvMappings map[string]interface{}
	Imports     []map[string]interface{}
}

// ExportEntry represents a single thonnas-config export entry
type ExportEntry struct {
	Name           string      `json:"name"`
	Description    string      `json:"description,omitempty"`
	SelfImportPath string      `json:"selfImportPath"`
	Default        interface{} `json:"default,omitempty"`
	Format         string      `json:"format,omitempty"`
}

// ThonnasConfigDocument models the subset of schema we care about for merging
type ThonnasConfigDocument struct {
	Config   map[string]interface{}   `json:"config"`
	Imports  []map[string]interface{} `json:"imports"`
	Exports  []ExportEntry            `json:"exports"`
	Internal []InternalEntry          `json:"internal"`
}

// InternalEntry represents an internal env var (not exported to other components)
type InternalEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
}

// TypeInfo holds inferred type information for a config field
type TypeInfo struct {
	GoType       string
	IsSlice      bool
	IsDuration   bool
	IsStruct     bool
	StructFields map[string]TypeInfo
}

func main() {
	fmt.Println("🔧 Generating type-safe configuration code...")

	// Ensure we're in the api-go directory
	if _, err := os.Stat("internal"); os.IsNotExist(err) {
		fmt.Println("❌ Error: Must run from api-go directory")
		os.Exit(1)
	}

	// Create config directory if it doesn't exist
	if err := os.MkdirAll("config", 0755); err != nil {
		fmt.Printf("❌ Error creating config directory: %v\n", err)
		os.Exit(1)
	}

	// Step 1: Discover and load module configs from thonnas-config files
	moduleConfigs, moduleExports, moduleSecretMappings, err := discoverModuleConfigs("internal/modules")
	if err != nil {
		fmt.Printf("❌ Error discovering module configs: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("📦 Found %d module configs\n", len(moduleConfigs))

	if cacheConfig, cacheExports, err := loadInlineThonnasConfig("internal/common/thonnas/cache/thonnas-config.json", "cache"); err == nil {
		moduleConfigs["cache"] = cacheConfig
		moduleExports = append(moduleExports, cacheExports...)
		fmt.Println("  ✅ Loaded cache noop config from internal/common/thonnas/cache")
	} else if !os.IsNotExist(err) {
		fmt.Printf("⚠️  Warning: Failed to load cache thonnas-config: %v\n", err)
	}

	// Step 2: Build Layer 1 (module defaults)
	moduleDefaults := buildModuleDefaults(moduleConfigs)

	// Load component-level app config straight from thonnas-config.json
	appConfig, appExports, err := readScopedConfig("thonnas-config.json", "app")
	if err != nil {
		fmt.Printf("❌ Error: Failed to load thonnas-config.json: %v\n", err)
		fmt.Println("   Please ensure thonnas-config.json exists with app defaults and exports")
		os.Exit(1)
	}
	fmt.Println("  ✅ Loaded app config from thonnas-config.json")

	// Load secrets and merge secret paths into app config
	// This ensures secret fields exist in the generated struct
	var secretMappings []SecretMapping
	appSecrets, err := readSecretsDoc("thonnas-secrets.json")
	if err != nil {
		fmt.Printf("⚠️  Warning: Failed to load thonnas-secrets.json: %v\n", err)
	} else {
		secretCount := 0
		// Process secret imports (values from other components)
		if len(appSecrets.Imports) > 0 {
			appConfig.Config = mergeSecretImportsIntoConfig(appConfig.Config, appSecrets, "app")
			appConfig.EnvMappings = mergeSecretEnvMappings(appConfig.EnvMappings, appSecrets, "app")
			secretMappings = append(secretMappings, collectSecretImportMappings(appSecrets, "app")...)
			secretCount += len(appSecrets.Imports)
		}
		// Process secret exports (values this component generates/owns)
		if len(appSecrets.Exports) > 0 {
			appConfig.Config = mergeSecretExportsIntoConfig(appConfig.Config, appSecrets, "app")
			appConfig.EnvMappings = mergeSecretExportEnvMappings(appConfig.EnvMappings, appSecrets, "app")
			secretMappings = append(secretMappings, collectSecretExportMappings(appSecrets, "app")...)
			secretCount += len(appSecrets.Exports)
		}
		if secretCount > 0 {
			fmt.Printf("  ✅ Merged %d secrets from thonnas-secrets.json\n", secretCount)
		}
	}
	secretMappings = append(secretMappings, moduleSecretMappings...)

	appDefaults := appConfig.Config
	appEnvMappings := appConfig.EnvMappings
	appImports := appConfig.Imports

	// Step 2b: Generate env-layer JSON from installed modules (gitignored; not published)
	if err := writeGeneratedEnvLayerFiles(moduleConfigs); err != nil {
		fmt.Printf("❌ Error generating env-layer config files: %v\n", err)
		os.Exit(1)
	}

	// Step 3: Load Layer 2 (shared defaults - config/default.yaml)
	sharedDefaults := deepMerge(
		map[string]interface{}{"app": appDefaults, "modules": moduleDefaults},
		loadJSONFile("config/default.thonnas-config.json"),
	)

	// Step 4: Load Layer 3 (environment-specific configs)
	environments := []string{"development", "beta", "staging", "production", "test"}
	envConfigs := make(map[string]map[string]interface{})

	for _, env := range environments {
		envFile := fmt.Sprintf("config/%s.thonnas-config.json", env)
		envJSON := loadJSONFile(envFile)
		envConfigs[env] = deepMerge(sharedDefaults, envJSON)
		fmt.Printf("  ✅ Merged config for %s environment\n", env)
	}

	// Step 5: Infer types from merged configs
	typeRegistry := inferTypes(sharedDefaults)

	// Step 6: Build env mappings
	envMappings := buildEnvMappings(appEnvMappings, moduleConfigs)

	// Step 6b: Aggregate imports/exports for generated thonnas-config
	allExports := append([]ExportEntry{}, moduleExports...)
	allExports = append(allExports, appExports...)

	allImports := append([]map[string]interface{}{}, appImports...)
	for _, moduleConfig := range moduleConfigs {
		if len(moduleConfig.Imports) > 0 {
			allImports = append(allImports, moduleConfig.Imports...)
		}
	}

	// Step 7: Generate Go code
	generator := &CodeGenerator{
		EnvConfigs:     envConfigs,
		TypeRegistry:   typeRegistry,
		EnvMappings:    envMappings,
		SecretMappings: secretMappings,
	}

	if err := generator.Generate("internal/config/generated.go"); err != nil {
		fmt.Printf("❌ Error generating code: %v\n", err)
		os.Exit(1)
	}

	// Step 8: Emit merged thonnas-config for api-go consumers
	if err := writeGeneratedThonnasConfig(sharedDefaults, envConfigs, allImports, allExports); err != nil {
		fmt.Printf("❌ Error writing thonnas-config.generated.json: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("✅ Generated internal/config/generated.go")
	fmt.Println("✅ Generated thonnas-config.generated.json")
	fmt.Println("✨ Configuration generation complete!")
	fmt.Println("   → 4-layer merge: module defaults → default.thonnas-config → {env}.thonnas-config → ENV vars")
}

// discoverModuleConfigs scans the modules directory for thonnas-config.json files
func discoverModuleConfigs(rootPath string) (map[string]ModuleConfig, []ExportEntry, []SecretMapping, error) {
	configs := make(map[string]ModuleConfig)
	var exports []ExportEntry
	var secretMappings []SecretMapping

	err := filepath.Walk(rootPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if info.IsDir() || info.Name() != "thonnas-config.json" {
			return nil
		}

		moduleName := filepath.Base(filepath.Dir(path))
		doc, err := readThonnasDoc(path)
		if err != nil {
			fmt.Printf("⚠️  Warning: Failed to read %s: %v\n", path, err)
			return nil
		}

		moduleConfig, moduleExports := moduleConfigFromDoc(moduleName, doc)
		secretsPath := filepath.Join(filepath.Dir(path), "thonnas-secrets.json")
		if secretsDoc, err := readSecretsDoc(secretsPath); err == nil {
			if len(secretsDoc.Imports) > 0 {
				moduleConfig.Config = mergeSecretImportsIntoConfig(moduleConfig.Config, secretsDoc, moduleName)
				moduleConfig.EnvMappings = mergeSecretEnvMappings(moduleConfig.EnvMappings, secretsDoc, moduleName)
				secretMappings = append(secretMappings, collectSecretImportMappings(secretsDoc, moduleName)...)
			}
			if len(secretsDoc.Exports) > 0 {
				moduleConfig.Config = mergeSecretExportsIntoConfig(moduleConfig.Config, secretsDoc, moduleName)
				moduleConfig.EnvMappings = mergeSecretExportEnvMappings(moduleConfig.EnvMappings, secretsDoc, moduleName)
				secretMappings = append(secretMappings, collectSecretExportMappings(secretsDoc, moduleName)...)
			}
		}
		configs[moduleName] = moduleConfig
		exports = append(exports, moduleExports...)
		fmt.Printf("  ✅ Loaded %s module config\n", moduleName)

		return nil
	})

	return configs, exports, secretMappings, err
}

// loadInlineThonnasConfig loads a thonnas-config.json outside internal/modules (e.g. common/thonnas/cache).
func loadInlineThonnasConfig(path, moduleName string) (ModuleConfig, []ExportEntry, error) {
	if _, err := os.Stat(path); err != nil {
		return ModuleConfig{}, nil, err
	}
	doc, err := readThonnasDoc(path)
	if err != nil {
		return ModuleConfig{}, nil, err
	}
	moduleConfig, moduleExports := moduleConfigFromDoc(moduleName, doc)
	return moduleConfig, moduleExports, nil
}

// readScopedConfig reads a thonnas-config file and extracts the specified scope (e.g., "app")
func readScopedConfig(path, scope string) (ModuleConfig, []ExportEntry, error) {
	doc, err := readThonnasDoc(path)
	if err != nil {
		return ModuleConfig{}, nil, err
	}
	moduleConfig, moduleExports := moduleConfigFromDoc(scope, doc)
	return moduleConfig, moduleExports, nil
}

// moduleConfigFromDoc converts a thonnas-config document into ModuleConfig + exports for a scope
func moduleConfigFromDoc(scope string, doc ThonnasConfigDocument) (ModuleConfig, []ExportEntry) {
	config := pluckScopeConfig(doc.Config, scope)
	envMappings := envMappingsFromEntries(scope, doc.Exports, doc.Imports, doc.Internal)
	return ModuleConfig{
		Config:      config,
		EnvMappings: envMappings,
		Imports:     doc.Imports,
	}, doc.Exports
}

// pluckScopeConfig extracts the nested map for the given scope (module/app)
func pluckScopeConfig(config map[string]interface{}, scope string) map[string]interface{} {
	if config == nil {
		return make(map[string]interface{})
	}
	if scoped, ok := config[scope]; ok {
		if scopedMap, ok := scoped.(map[string]interface{}); ok {
			return scopedMap
		}
	}
	if len(config) == 1 {
		for _, value := range config {
			if scopedMap, ok := value.(map[string]interface{}); ok {
				return scopedMap
			}
		}
	}
	return make(map[string]interface{})
}

// envMappingsFromExports derives env override mapping from thonnas-config exports, imports, and internal
// Paths can be either:
// - Prefixed with scope (e.g., "mqtt.brokerHost") - prefix is stripped
// - Relative/unprefixed (e.g., "brokerHost") - used as-is (inferred from module folder)
func envMappingsFromEntries(scope string, exports []ExportEntry, imports []map[string]interface{}, internal []InternalEntry) map[string]interface{} {
	if len(exports) == 0 && len(imports) == 0 && len(internal) == 0 {
		return nil
	}

	mappings := make(map[string]interface{})
	scopePrefix := scope + "."

	// Helper to normalize path - strips scope prefix if present, otherwise uses as-is
	normalizePath := func(path string) string {
		if strings.HasPrefix(path, scopePrefix) {
			return strings.TrimPrefix(path, scopePrefix)
		}
		// Path is already relative (no scope prefix) - use as-is
		return path
	}

	// Process exports (component-scoped env vars)
	for _, export := range exports {
		if export.Name == "" || export.SelfImportPath == "" {
			continue
		}
		relative := normalizePath(export.SelfImportPath)
		if relative == "" || relative == scope {
			continue
		}
		mappings[relative] = export.Name
	}

	// Process imports (env vars from other components)
	for _, imp := range imports {
		nameRaw, ok := imp["name"].(string)
		if !ok {
			continue
		}
		pathRaw, ok := imp["path"].(string)
		if !ok {
			continue
		}
		path := strings.TrimSpace(pathRaw)
		if path == "" {
			continue
		}
		relative := normalizePath(path)
		if relative == "" || relative == scope {
			continue
		}
		mappings[relative] = nameRaw
	}

	// Process internal (local env vars not shared with other components)
	for _, entry := range internal {
		if entry.Name == "" || entry.Path == "" {
			continue
		}
		path := strings.TrimSpace(entry.Path)
		relative := normalizePath(path)
		if relative == "" || relative == scope {
			continue
		}
		mappings[relative] = entry.Name
	}

	if len(mappings) == 0 {
		return nil
	}

	return mappings
}

// readThonnasDoc loads a thonnas-config JSON file
func readThonnasDoc(path string) (ThonnasConfigDocument, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return ThonnasConfigDocument{}, err
	}

	var doc ThonnasConfigDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return ThonnasConfigDocument{}, err
	}

	if doc.Config == nil {
		doc.Config = make(map[string]interface{})
	}

	return doc, nil
}

// ThonnasSecretsDocument represents a thonnas-secrets.json file
type ThonnasSecretsDocument struct {
	Imports []map[string]interface{} `json:"imports"`
	Exports []map[string]interface{} `json:"exports"`
}

// readSecretsDoc loads a thonnas-secrets.json file
func readSecretsDoc(path string) (ThonnasSecretsDocument, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ThonnasSecretsDocument{}, nil
		}
		return ThonnasSecretsDocument{}, err
	}

	var doc ThonnasSecretsDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return ThonnasSecretsDocument{}, err
	}

	return doc, nil
}

// mergeSecretImportsIntoConfig adds secret import paths as empty string fields in config
// This ensures secret fields exist in the generated struct while keeping defaults in secrets file
func mergeSecretImportsIntoConfig(config map[string]interface{}, secrets ThonnasSecretsDocument, scope string) map[string]interface{} {
	scopePrefix := scope + "."

	for _, imp := range secrets.Imports {
		pathRaw, ok := imp["path"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		// Only process paths that match our scope (e.g., "app.jwtSecret" for scope "app")
		if !strings.HasPrefix(pathRaw, scopePrefix) {
			continue
		}

		// Extract the field name after scope prefix (e.g., "jwtSecret" from "app.jwtSecret")
		fieldPath := strings.TrimPrefix(pathRaw, scopePrefix)
		if fieldPath == "" {
			continue
		}

		// Set empty string default - actual value comes from env var at runtime
		setNestedValue(config, fieldPath, "")
	}

	return config
}

// setNestedValue sets a value at a nested path (e.g., "security.apiKey" → config["security"]["apiKey"])
func setNestedValue(config map[string]interface{}, path string, value interface{}) {
	parts := strings.Split(path, ".")
	current := config

	for i, part := range parts {
		if i == len(parts)-1 {
			// Last part - only set if not already exists (don't overwrite)
			if _, exists := current[part]; !exists {
				current[part] = value
			}
		} else {
			// Intermediate part - create nested map if needed
			if next, ok := current[part].(map[string]interface{}); ok {
				current = next
			} else {
				newMap := make(map[string]interface{})
				current[part] = newMap
				current = newMap
			}
		}
	}
}

// mergeSecretEnvMappings adds secret import env var → path mappings
func mergeSecretEnvMappings(envMappings map[string]interface{}, secrets ThonnasSecretsDocument, scope string) map[string]interface{} {
	if envMappings == nil {
		envMappings = make(map[string]interface{})
	}

	scopePrefix := scope + "."

	for _, imp := range secrets.Imports {
		nameRaw, ok := imp["name"].(string)
		if !ok || nameRaw == "" {
			continue
		}
		pathRaw, ok := imp["path"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		// Only process paths that match our scope
		if !strings.HasPrefix(pathRaw, scopePrefix) {
			continue
		}

		// Extract the field path after scope prefix
		fieldPath := strings.TrimPrefix(pathRaw, scopePrefix)
		if fieldPath == "" {
			continue
		}

		// Add env var → field path mapping (with SECRET__ prefix for runtime)
		envMappings[fieldPath] = "SECRET__" + nameRaw
	}

	return envMappings
}

// mergeSecretExportsIntoConfig adds secret export paths as empty string fields in config
// This ensures secret fields exist in the generated struct while keeping defaults in secrets file
func mergeSecretExportsIntoConfig(config map[string]interface{}, secrets ThonnasSecretsDocument, scope string) map[string]interface{} {
	scopePrefix := scope + "."

	for _, exp := range secrets.Exports {
		pathRaw, ok := exp["selfImportPath"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		// Only process paths that match our scope (e.g., "app.security.jwtSecret" for scope "app")
		// Also handle paths without scope prefix (e.g., "security.jwtSecret")
		var fieldPath string
		if strings.HasPrefix(pathRaw, scopePrefix) {
			fieldPath = strings.TrimPrefix(pathRaw, scopePrefix)
		} else if !strings.Contains(pathRaw, ".") || !strings.HasPrefix(pathRaw, scope) {
			// Path is relative (e.g., "security.jwtSecret") - use as-is
			fieldPath = pathRaw
		} else {
			continue
		}

		if fieldPath == "" {
			continue
		}

		// Set empty string default - actual value comes from env var at runtime
		setNestedValue(config, fieldPath, "")
	}

	return config
}

// mergeSecretExportEnvMappings adds secret export env var → path mappings
func mergeSecretExportEnvMappings(envMappings map[string]interface{}, secrets ThonnasSecretsDocument, scope string) map[string]interface{} {
	if envMappings == nil {
		envMappings = make(map[string]interface{})
	}

	scopePrefix := scope + "."

	for _, exp := range secrets.Exports {
		nameRaw, ok := exp["name"].(string)
		if !ok || nameRaw == "" {
			continue
		}
		pathRaw, ok := exp["selfImportPath"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		// Handle paths with or without scope prefix
		var fieldPath string
		if strings.HasPrefix(pathRaw, scopePrefix) {
			fieldPath = strings.TrimPrefix(pathRaw, scopePrefix)
		} else if !strings.Contains(pathRaw, ".") || !strings.HasPrefix(pathRaw, scope) {
			// Path is relative - use as-is
			fieldPath = pathRaw
		} else {
			continue
		}

		if fieldPath == "" {
			continue
		}

		// Add env var → field path mapping (with SECRET__ prefix for runtime)
		envMappings[fieldPath] = "SECRET__" + nameRaw
	}

	return envMappings
}

// collectSecretImportMappings collects secret import info for getter generation
func collectSecretImportMappings(secrets ThonnasSecretsDocument, scope string) []SecretMapping {
	var mappings []SecretMapping
	scopePrefix := scope + "."

	for _, imp := range secrets.Imports {
		nameRaw, ok := imp["name"].(string)
		if !ok || nameRaw == "" {
			continue
		}
		pathRaw, ok := imp["path"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		if !strings.HasPrefix(pathRaw, scopePrefix) {
			continue
		}

		fieldPath := strings.TrimPrefix(pathRaw, scopePrefix)
		if fieldPath == "" {
			continue
		}

		// Extract just the field name (last part of path)
		parts := strings.Split(fieldPath, ".")
		fieldName := parts[len(parts)-1]

		mappings = append(mappings, SecretMapping{
			EnvVar:    "SECRET__" + nameRaw,
			FieldPath: fieldPath,
			FieldName: fieldName,
		})
	}

	return mappings
}

// collectSecretExportMappings collects secret export info for getter generation
func collectSecretExportMappings(secrets ThonnasSecretsDocument, scope string) []SecretMapping {
	var mappings []SecretMapping
	scopePrefix := scope + "."

	for _, exp := range secrets.Exports {
		nameRaw, ok := exp["name"].(string)
		if !ok || nameRaw == "" {
			continue
		}
		pathRaw, ok := exp["selfImportPath"].(string)
		if !ok || pathRaw == "" {
			continue
		}

		// Handle paths with or without scope prefix
		var fieldPath string
		if strings.HasPrefix(pathRaw, scopePrefix) {
			fieldPath = strings.TrimPrefix(pathRaw, scopePrefix)
		} else if !strings.Contains(pathRaw, ".") || !strings.HasPrefix(pathRaw, scope) {
			fieldPath = pathRaw
		} else {
			continue
		}

		if fieldPath == "" {
			continue
		}

		// Extract just the field name (last part of path)
		parts := strings.Split(fieldPath, ".")
		fieldName := parts[len(parts)-1]

		mappings = append(mappings, SecretMapping{
			EnvVar:    "SECRET__" + nameRaw,
			FieldPath: fieldPath,
			FieldName: fieldName,
		})
	}

	return mappings
}

// loadJSONFile loads a thonnas-config JSON file and returns the config map (empty if missing)
func loadJSONFile(path string) map[string]interface{} {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]interface{})
		}
		fmt.Printf("⚠️  Warning: Failed to read %s: %v\n", path, err)
		return make(map[string]interface{})
	}

	var doc ThonnasConfigDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		fmt.Printf("⚠️  Warning: Failed to parse %s: %v\n", path, err)
		return make(map[string]interface{})
	}

	if doc.Config == nil {
		return make(map[string]interface{})
	}

	return doc.Config
}

// buildModuleDefaults extracts config section from all modules
func buildModuleDefaults(moduleConfigs map[string]ModuleConfig) map[string]interface{} {
	result := make(map[string]interface{})
	for moduleName, moduleConfig := range moduleConfigs {
		if moduleConfig.Config != nil {
			result[moduleName] = moduleConfig.Config
		}
	}
	return result
}

// buildEnvMappings combines app and module env mappings
func buildEnvMappings(appMappings map[string]interface{}, moduleConfigs map[string]ModuleConfig) map[string]map[string]interface{} {
	result := map[string]map[string]interface{}{
		"app": appMappings,
	}

	for moduleName, moduleConfig := range moduleConfigs {
		if moduleConfig.EnvMappings != nil {
			result[moduleName] = moduleConfig.EnvMappings
		}
	}

	return result
}

// deepMerge merges two nested maps (second overrides first)
func deepMerge(base, override map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})

	// Copy base
	for k, v := range base {
		result[k] = v
	}

	// Merge override
	for k, v := range override {
		if existingVal, exists := result[k]; exists {
			// If both are maps, merge recursively
			if existingMap, ok := existingVal.(map[string]interface{}); ok {
				if overrideMap, ok := v.(map[string]interface{}); ok {
					result[k] = deepMerge(existingMap, overrideMap)
					continue
				}
			}
		}
		// Otherwise, override
		result[k] = v
	}

	return result
}

// inferTypes infers Go types from YAML values
func inferTypes(config map[string]interface{}) map[string]TypeInfo {
	registry := make(map[string]TypeInfo)

	if app, ok := config["app"].(map[string]interface{}); ok {
		registry["AppConfig"] = inferStructType(app)
	}

	if modules, ok := config["modules"].(map[string]interface{}); ok {
		for moduleName, moduleConfig := range modules {
			if mc, ok := moduleConfig.(map[string]interface{}); ok {
				structName := toPascalCase(moduleName) + "Config"
				registry[structName] = inferStructType(mc)
			}
		}
	}

	return registry
}

// inferStructType infers struct fields and types
func inferStructType(data map[string]interface{}) TypeInfo {
	fields := make(map[string]TypeInfo)

	for key, value := range data {
		fields[key] = inferFieldType(value)
	}

	return TypeInfo{
		GoType:       "struct",
		IsStruct:     true,
		StructFields: fields,
	}
}

// inferFieldType infers the Go type for a field value
func inferFieldType(value interface{}) TypeInfo {
	switch v := value.(type) {
	case string:
		// Check if it's a duration
		if _, err := time.ParseDuration(v); err == nil {
			return TypeInfo{GoType: "time.Duration", IsDuration: true}
		}
		return TypeInfo{GoType: "string"}

	case int, int64:
		return TypeInfo{GoType: "int"}

	case float64:
		// Check if it's actually an int
		if v == float64(int(v)) {
			return TypeInfo{GoType: "int"}
		}
		return TypeInfo{GoType: "float64"}

	case bool:
		return TypeInfo{GoType: "bool"}

	case []interface{}:
		if len(v) > 0 {
			elemType := inferFieldType(v[0])
			return TypeInfo{GoType: elemType.GoType, IsSlice: true}
		}
		return TypeInfo{GoType: "string", IsSlice: true}

	case map[string]interface{}:
		return inferStructType(v)

	default:
		return TypeInfo{GoType: "interface{}"}
	}
}

// SecretMapping holds info about a secret for code generation
type SecretMapping struct {
	EnvVar    string // e.g., "SECRET__API_GO_JWT_SECRET"
	FieldPath string // e.g., "security.jwtSecret"
	FieldName string // e.g., "jwtSecret"
}

// CodeGenerator generates Go code
type CodeGenerator struct {
	EnvConfigs     map[string]map[string]interface{}
	TypeRegistry   map[string]TypeInfo
	EnvMappings    map[string]map[string]interface{}
	SecretMappings []SecretMapping
}

// Generate creates the generated.go file
func (g *CodeGenerator) Generate(outputPath string) error {
	var buf bytes.Buffer

	// Write header
	g.writeHeader(&buf)

	// Write struct definitions
	g.writeStructs(&buf)

	// Write pre-compiled environment configs
	g.writeEnvConfigs(&buf)

	// Write Load function
	g.writeLoadFunction(&buf)

	// Write applyEnvOverrides function
	g.writeApplyEnvOverrides(&buf)

	// Write convenience getters
	g.writeGetters(&buf)

	// Format with gofmt
	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		// Write unformatted for debugging
		os.WriteFile(outputPath+".unformatted", buf.Bytes(), 0644)
		return fmt.Errorf("failed to format generated code: %w (unformatted saved to %s.unformatted)", err, outputPath)
	}

	// Write to file
	return os.WriteFile(outputPath, formatted, 0644)
}

// writeHeader writes the file header
func (g *CodeGenerator) writeHeader(buf *bytes.Buffer) {
	needsStrings := g.hasSliceEnvOverride()
	needsStrconv := g.needsStrconvImport()

	buf.WriteString("// Code generated by aggregate-configs.go. DO NOT EDIT.\n\npackage config\n\nimport (\n\t\"os\"\n")
	if needsStrconv {
		buf.WriteString("\t\"strconv\"\n")
	}
	if needsStrings {
		buf.WriteString("\t\"strings\"\n")
	}
	buf.WriteString("\t\"time\"\n)\n\n")
}

// needsStrconvImport checks if applyEnvOverrides uses numeric or bool parsing
func (g *CodeGenerator) needsStrconvImport() bool {
	for scope, mappings := range g.EnvMappings {
		var typeInfo TypeInfo
		if scope == "app" {
			typeInfo = g.TypeRegistry["AppConfig"]
		} else {
			structName := toPascalCase(scope) + "Config"
			var ok bool
			typeInfo, ok = g.TypeRegistry[structName]
			if !ok {
				continue
			}
		}

		for fieldName := range mappings {
			fieldType, ok := typeInfo.StructFields[fieldName]
			if !ok || fieldType.IsSlice {
				continue
			}
			switch fieldType.GoType {
			case "int", "bool", "float64":
				return true
			}
		}
	}
	return false
}

// hasSliceEnvOverride checks if any env mapping targets a slice field
func (g *CodeGenerator) hasSliceEnvOverride() bool {
	for scope, mappings := range g.EnvMappings {
		var typeInfo TypeInfo
		if scope == "app" {
			typeInfo = g.TypeRegistry["AppConfig"]
		} else {
			structName := toPascalCase(scope) + "Config"
			var ok bool
			typeInfo, ok = g.TypeRegistry[structName]
			if !ok {
				continue
			}
		}

		for fieldName := range mappings {
			if fieldType, ok := typeInfo.StructFields[fieldName]; ok && fieldType.IsSlice {
				return true
			}
		}
	}
	return false
}

// writeStructs writes all struct definitions
func (g *CodeGenerator) writeStructs(buf *bytes.Buffer) {
	// Get sorted struct names for deterministic output
	var structNames []string
	for name := range g.TypeRegistry {
		structNames = append(structNames, name)
	}
	sort.Strings(structNames)

	// Write each struct
	for _, structName := range structNames {
		typeInfo := g.TypeRegistry[structName]
		g.writeStruct(buf, structName, typeInfo)
		buf.WriteString("\n")
	}

	// Write main Config struct
	buf.WriteString("// Config holds all configuration values\n")
	buf.WriteString("type Config struct {\n")
	buf.WriteString("\tApp AppConfig\n")

	// Add module fields (sorted)
	var moduleNames []string
	for name := range g.TypeRegistry {
		if name != "AppConfig" {
			moduleNames = append(moduleNames, name)
		}
	}
	sort.Strings(moduleNames)

	for _, moduleName := range moduleNames {
		fieldName := strings.TrimSuffix(moduleName, "Config")
		buf.WriteString(fmt.Sprintf("\t%s %s\n", fieldName, moduleName))
	}

	buf.WriteString("}\n\n")
}

// writeStruct writes a single struct definition
func (g *CodeGenerator) writeStruct(buf *bytes.Buffer, structName string, typeInfo TypeInfo) {
	if !typeInfo.IsStruct {
		return
	}

	buf.WriteString(fmt.Sprintf("// %s configuration\n", structName))
	buf.WriteString(fmt.Sprintf("type %s struct {\n", structName))

	// Get sorted field names
	var fieldNames []string
	for fieldName := range typeInfo.StructFields {
		fieldNames = append(fieldNames, fieldName)
	}
	sort.Strings(fieldNames)

	// Write each field
	for _, fieldName := range fieldNames {
		fieldType := typeInfo.StructFields[fieldName]
		goFieldName := toPascalCase(fieldName)
		goType := g.formatGoType(fieldType)

		buf.WriteString(fmt.Sprintf("\t%s %s\n", goFieldName, goType))
	}

	buf.WriteString("}\n\n")
}

// formatGoType formats a TypeInfo as a Go type string
func (g *CodeGenerator) formatGoType(typeInfo TypeInfo) string {
	if typeInfo.IsSlice {
		return "[]" + typeInfo.GoType
	}
	if typeInfo.IsStruct {
		// Handle nested structs - for now use map, could be enhanced
		return "map[string]interface{}"
	}
	return typeInfo.GoType
}

// writeEnvConfigs writes pre-compiled environment configurations
func (g *CodeGenerator) writeEnvConfigs(buf *bytes.Buffer) {
	environments := []string{"development", "beta", "staging", "production", "test"}

	for _, env := range environments {
		config, ok := g.EnvConfigs[env]
		if !ok {
			continue
		}

		buf.WriteString(fmt.Sprintf("// %sConfig is the pre-merged configuration for %s environment\n", env, env))
		buf.WriteString(fmt.Sprintf("var %sConfig = Config{\n", env))

		// Write App config
		if app, ok := config["app"].(map[string]interface{}); ok {
			buf.WriteString("\tApp: AppConfig{\n")
			g.writeStructLiteral(buf, "\t\t", g.TypeRegistry["AppConfig"], app)
			buf.WriteString("\t},\n")
		}

		// Write module configs
		if modules, ok := config["modules"].(map[string]interface{}); ok {
			// Get sorted module names
			var moduleNames []string
			for moduleName := range modules {
				moduleNames = append(moduleNames, moduleName)
			}
			sort.Strings(moduleNames)

			for _, moduleName := range moduleNames {
				if moduleConfig, ok := modules[moduleName].(map[string]interface{}); ok {
					structName := toPascalCase(moduleName) + "Config"
					fieldName := toPascalCase(moduleName)

					if typeInfo, ok := g.TypeRegistry[structName]; ok {
						buf.WriteString(fmt.Sprintf("\t%s: %s{\n", fieldName, structName))
						g.writeStructLiteral(buf, "\t\t", typeInfo, moduleConfig)
						buf.WriteString("\t},\n")
					}
				}
			}
		}

		buf.WriteString("}\n\n")
	}
}

// writeStructLiteral writes a struct literal with values
func (g *CodeGenerator) writeStructLiteral(buf *bytes.Buffer, indent string, typeInfo TypeInfo, data map[string]interface{}) {
	// Get sorted field names
	var fieldNames []string
	for fieldName := range typeInfo.StructFields {
		fieldNames = append(fieldNames, fieldName)
	}
	sort.Strings(fieldNames)

	for _, fieldName := range fieldNames {
		fieldType := typeInfo.StructFields[fieldName]
		goFieldName := toPascalCase(fieldName)

		value, ok := data[fieldName]
		if !ok {
			continue // Skip fields not present in data
		}

		formattedValue := g.formatValue(fieldType, value)
		buf.WriteString(fmt.Sprintf("%s%s: %s,\n", indent, goFieldName, formattedValue))
	}
}

// formatValue formats a value for Go code
func (g *CodeGenerator) formatValue(typeInfo TypeInfo, value interface{}) string {
	if value == nil {
		return "nil"
	}

	switch typeInfo.GoType {
	case "string":
		if typeInfo.IsSlice {
			if arr, ok := value.([]interface{}); ok {
				var strs []string
				for _, v := range arr {
					strs = append(strs, fmt.Sprintf("%q", fmt.Sprint(v)))
				}
				return "[]string{" + strings.Join(strs, ", ") + "}"
			}
		}
		return fmt.Sprintf("%q", fmt.Sprint(value))

	case "int":
		if typeInfo.IsSlice {
			if arr, ok := value.([]interface{}); ok {
				var ints []string
				for _, v := range arr {
					ints = append(ints, fmt.Sprint(v))
				}
				return "[]int{" + strings.Join(ints, ", ") + "}"
			}
		}
		// Handle float64 from JSON/YAML
		if f, ok := value.(float64); ok {
			return strconv.Itoa(int(f))
		}
		return fmt.Sprint(value)

	case "float64":
		return fmt.Sprint(value)

	case "bool":
		return fmt.Sprint(value)

	case "time.Duration":
		if s, ok := value.(string); ok {
			// Parse and convert to Go duration literal
			if d, err := time.ParseDuration(s); err == nil {
				return fmt.Sprintf("%d * time.Nanosecond", d.Nanoseconds())
			}
		}
		return fmt.Sprintf("%q", fmt.Sprint(value))

	default:
		return fmt.Sprintf("%#v", value)
	}
}

// writeLoadFunction writes the Load function
func (g *CodeGenerator) writeLoadFunction(buf *bytes.Buffer) {
	tmpl := `// Load loads configuration based on THONNAS_ENV (falls back to GO_ENV) and applies environment variable overrides
func Load() (*Config, error) {
	env := os.Getenv("THONNAS_ENV")
	if env == "" {
		env = os.Getenv("GO_ENV")
	}
	if env == "" {
		env = "development"
	}

	var cfg Config

	// Select pre-compiled config based on environment
	switch env {
	case "production":
		cfg = productionConfig
	case "staging":
		cfg = stagingConfig
	case "beta":
		cfg = betaConfig
	case "test":
		cfg = testConfig
	default:
		cfg = developmentConfig
	}

	// Apply environment variable overrides (Layer 4)
	cfg.applyEnvOverrides()

	return &cfg, nil
}
`

	buf.WriteString(tmpl)
}

// writeApplyEnvOverrides writes the applyEnvOverrides function
func (g *CodeGenerator) writeApplyEnvOverrides(buf *bytes.Buffer) {
	buf.WriteString("// applyEnvOverrides applies environment variable overrides\n")
	buf.WriteString("func (c *Config) applyEnvOverrides() {\n")

	// App-level env overrides
	if appMappings, ok := g.EnvMappings["app"]; ok {
		buf.WriteString("\t// App configuration overrides\n")
		g.writeEnvOverridesForStruct(buf, "\tc.App.", appMappings, g.TypeRegistry["AppConfig"])
	}

	// Module env overrides
	for moduleName, mappings := range g.EnvMappings {
		if moduleName == "app" {
			continue
		}

		structName := toPascalCase(moduleName) + "Config"
		fieldName := toPascalCase(moduleName)

		if typeInfo, ok := g.TypeRegistry[structName]; ok {
			buf.WriteString(fmt.Sprintf("\n\t// %s module overrides\n", moduleName))
			g.writeEnvOverridesForStruct(buf, fmt.Sprintf("\tc.%s.", fieldName), mappings, typeInfo)
		}
	}

	buf.WriteString("}\n\n")
}

// writeEnvOverridesForStruct writes env override code for a struct
func (g *CodeGenerator) writeEnvOverridesForStruct(buf *bytes.Buffer, prefix string, mappings map[string]interface{}, typeInfo TypeInfo) {
	// Get sorted field names
	var fieldNames []string
	for fieldName := range mappings {
		fieldNames = append(fieldNames, fieldName)
	}
	sort.Strings(fieldNames)

	for _, fieldName := range fieldNames {
		envVar, ok := mappings[fieldName].(string)
		if !ok {
			continue
		}

		goFieldName := toPascalCase(fieldName)
		fieldType, ok := typeInfo.StructFields[fieldName]
		if !ok {
			continue
		}

		g.writeEnvOverride(buf, prefix+goFieldName, envVar, fieldType)
	}
}

// writeEnvOverride writes a single env var override
func (g *CodeGenerator) writeEnvOverride(buf *bytes.Buffer, fieldPath, envVar string, typeInfo TypeInfo) {
	buf.WriteString(fmt.Sprintf("\tif v := os.Getenv(%q); v != \"\" {\n", envVar))

	switch typeInfo.GoType {
	case "string":
		if typeInfo.IsSlice {
			buf.WriteString(fmt.Sprintf("\t\t%s = strings.Split(v, \",\")\n", fieldPath))
		} else {
			buf.WriteString(fmt.Sprintf("\t\t%s = v\n", fieldPath))
		}

	case "int":
		buf.WriteString(fmt.Sprintf("\t\tif i, err := strconv.Atoi(v); err == nil {\n"))
		buf.WriteString(fmt.Sprintf("\t\t\t%s = i\n", fieldPath))
		buf.WriteString("\t\t}\n")

	case "bool":
		buf.WriteString(fmt.Sprintf("\t\tif b, err := strconv.ParseBool(v); err == nil {\n"))
		buf.WriteString(fmt.Sprintf("\t\t\t%s = b\n", fieldPath))
		buf.WriteString("\t\t}\n")

	case "time.Duration":
		buf.WriteString(fmt.Sprintf("\t\tif d, err := time.ParseDuration(v); err == nil {\n"))
		buf.WriteString(fmt.Sprintf("\t\t\t%s = d\n", fieldPath))
		buf.WriteString("\t\t}\n")

	case "float64":
		buf.WriteString(fmt.Sprintf("\t\tif f, err := strconv.ParseFloat(v, 64); err == nil {\n"))
		buf.WriteString(fmt.Sprintf("\t\t\t%s = f\n", fieldPath))
		buf.WriteString("\t\t}\n")
	}

	buf.WriteString("\t}\n")
}

// writeGetters writes convenience getter methods
func (g *CodeGenerator) writeGetters(buf *bytes.Buffer) {
	buf.WriteString("// Convenience getters for app-level config\n")

	appType := g.TypeRegistry["AppConfig"]
	if !appType.IsStruct {
		return
	}

	// Get sorted field names
	var fieldNames []string
	for fieldName := range appType.StructFields {
		fieldNames = append(fieldNames, fieldName)
	}
	sort.Strings(fieldNames)

	for _, fieldName := range fieldNames {
		fieldType := appType.StructFields[fieldName]
		goFieldName := toPascalCase(fieldName)
		goType := g.formatGoType(fieldType)

		buf.WriteString(fmt.Sprintf("func (c *Config) %s() %s { return c.App.%s }\n", goFieldName, goType, goFieldName))
	}

	buf.WriteString("\n")

	// Write module config getters
	var moduleNames []string
	for name := range g.TypeRegistry {
		if name != "AppConfig" && strings.HasSuffix(name, "Config") {
			moduleNames = append(moduleNames, name)
		}
	}
	sort.Strings(moduleNames)

	buf.WriteString("// Module config getters\n")
	for _, structName := range moduleNames {
		fieldName := strings.TrimSuffix(structName, "Config")
		buf.WriteString(fmt.Sprintf("func (c *Config) Get%sConfig() %s { return c.%s }\n", fieldName, structName, fieldName))
	}

	buf.WriteString("\n")

	// Write secret getters - these read from env vars at runtime
	if len(g.SecretMappings) > 0 {
		buf.WriteString("// Secret getters - read from environment variables at runtime\n")
		buf.WriteString("// Secrets should never be baked into binaries; they're loaded from env vars\n")
		for _, secret := range g.SecretMappings {
			methodName := toPascalCase(secret.FieldName)
			buf.WriteString(fmt.Sprintf("func (c *Config) %s() string {\n", methodName))
			buf.WriteString(fmt.Sprintf("\tif v := os.Getenv(%q); v != \"\" {\n", secret.EnvVar))
			buf.WriteString("\t\treturn v\n")
			buf.WriteString("\t}\n")
			// Also check without SECRET__ prefix as fallback
			nonSecretEnvVar := strings.TrimPrefix(secret.EnvVar, "SECRET__")
			buf.WriteString(fmt.Sprintf("\treturn os.Getenv(%q)\n", nonSecretEnvVar))
			buf.WriteString("}\n\n")
		}
	}

	// Write Validate method
	buf.WriteString("// Validate checks if required configuration values are set\n")
	buf.WriteString("func (c *Config) Validate() error {\n")
	buf.WriteString("\t// Add validation logic here\n")
	buf.WriteString("\treturn nil\n")
	buf.WriteString("}\n")
}

// toPascalCase converts kebab-case or snake_case to PascalCase
func toPascalCase(s string) string {
	// Replace separators with space
	s = strings.ReplaceAll(s, "-", " ")
	s = strings.ReplaceAll(s, "_", " ")

	// Split and capitalize each word
	words := strings.Fields(s)
	for i, word := range words {
		if len(word) > 0 {
			words[i] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
		}
	}

	return strings.Join(words, "")
}

// Note: App defaults and env mappings are loaded from thonnas-config.json
// This makes the system fully dynamic - no hardcoded config lists!

// writeGeneratedThonnasConfig writes the merged thonnas-config for api-go
// Note: environments are NOT included as they're already baked into generated.go
// and the thonnas-config schema doesn't allow additionalProperties
func writeGeneratedThonnasConfig(
	baseConfig map[string]interface{},
	envConfigs map[string]map[string]interface{},
	imports []map[string]interface{},
	exports []ExportEntry,
) error {
	payload := map[string]interface{}{
		"config":  baseConfig,
		"imports": normalizeImports(imports),
		"exports": normalizeExports(exports),
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile("thonnas-config.generated.json", data, 0644)
}

// normalizeExports de-duplicates exports by name and returns JSON-serializable maps
func normalizeExports(exports []ExportEntry) []map[string]interface{} {
	if len(exports) == 0 {
		return []map[string]interface{}{}
	}

	deduped := make(map[string]ExportEntry)
	for _, export := range exports {
		if export.Name == "" || export.SelfImportPath == "" {
			continue
		}
		deduped[export.Name] = export
	}

	names := make([]string, 0, len(deduped))
	for name := range deduped {
		names = append(names, name)
	}
	sort.Strings(names)

	result := make([]map[string]interface{}, 0, len(names))
	for _, name := range names {
		export := deduped[name]
		entry := map[string]interface{}{
			"name":           export.Name,
			"selfImportPath": export.SelfImportPath,
		}
		if export.Description != "" {
			entry["description"] = export.Description
		}
		if export.Default != nil {
			entry["default"] = export.Default
		}
		if export.Format != "" {
			entry["format"] = export.Format
		}
		result = append(result, entry)
	}

	return result
}

func normalizeImports(imports []map[string]interface{}) []map[string]interface{} {
	if len(imports) == 0 {
		return []map[string]interface{}{}
	}

	deduped := make(map[string]map[string]interface{})
	for _, entry := range imports {
		if entry == nil {
			continue
		}
		nameRaw, ok := entry["name"].(string)
		if !ok {
			continue
		}
		name := strings.TrimSpace(nameRaw)
		if name == "" {
			continue
		}
		deduped[name] = cloneMap(entry)
	}

	if len(deduped) == 0 {
		return []map[string]interface{}{}
	}

	names := make([]string, 0, len(deduped))
	for name := range deduped {
		names = append(names, name)
	}
	sort.Strings(names)

	result := make([]map[string]interface{}, 0, len(names))
	for _, name := range names {
		result = append(result, deduped[name])
	}
	return result
}

func cloneMap(input map[string]interface{}) map[string]interface{} {
	if input == nil {
		return nil
	}
	output := make(map[string]interface{}, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

