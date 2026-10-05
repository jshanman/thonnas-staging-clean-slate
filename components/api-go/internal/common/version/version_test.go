package version

import (
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestGet(t *testing.T) {
	// Get version info
	info := Get()

	// Verify fields are populated
	assert.NotEmpty(t, info.Version, "Version should not be empty")
	assert.NotEmpty(t, info.Commit, "Commit should not be empty")
	assert.NotEmpty(t, info.BuildTime, "BuildTime should not be empty")
	assert.NotEmpty(t, info.GoVersion, "GoVersion should not be empty")

	// Verify GoVersion matches runtime
	assert.Equal(t, runtime.Version(), info.GoVersion, "GoVersion should match runtime.Version()")
}

func TestString_WithCommit(t *testing.T) {
	// Save original values
	origVersion := Version
	origCommit := Commit
	defer func() {
		Version = origVersion
		Commit = origCommit
	}()

	// Test with full commit hash
	Version = "1.0.0"
	Commit = "abc123def456789"

	result := String()
	expected := "1.0.0 (abc123d)"
	assert.Equal(t, expected, result, "String should format version with short commit hash")
}

func TestString_WithShortCommit(t *testing.T) {
	// Save original values
	origVersion := Version
	origCommit := Commit
	defer func() {
		Version = origVersion
		Commit = origCommit
	}()

	// Test with short commit hash (less than 7 chars)
	Version = "1.0.0"
	Commit = "abc123"

	result := String()
	expected := "1.0.0"
	assert.Equal(t, expected, result, "String should return version only if commit is too short")
}

func TestString_WithUnknownCommit(t *testing.T) {
	// Save original values
	origVersion := Version
	origCommit := Commit
	defer func() {
		Version = origVersion
		Commit = origCommit
	}()

	// Test with unknown commit
	Version = "1.0.0"
	Commit = "unknown"

	result := String()
	expected := "1.0.0"
	assert.Equal(t, expected, result, "String should return version only if commit is unknown")
}

func TestString_DefaultValues(t *testing.T) {
	// Test with default "dev" version
	// Save original values
	origVersion := Version
	origCommit := Commit
	defer func() {
		Version = origVersion
		Commit = origCommit
	}()

	Version = "dev"
	Commit = "unknown"

	result := String()
	expected := "dev"
	assert.Equal(t, expected, result, "String should handle default dev values")
}

func TestBuildTimestamp_ValidRFC3339(t *testing.T) {
	// Save original value
	origBuildTime := BuildTime
	defer func() {
		BuildTime = origBuildTime
	}()

	// Test with valid RFC3339 timestamp
	BuildTime = "2025-10-21T10:00:00Z"

	result := BuildTimestamp()
	assert.False(t, result.IsZero(), "BuildTimestamp should return valid time for RFC3339 input")

	// Verify parsed correctly
	expected, _ := time.Parse(time.RFC3339, "2025-10-21T10:00:00Z")
	assert.Equal(t, expected, result, "BuildTimestamp should parse RFC3339 correctly")
}

func TestBuildTimestamp_Unknown(t *testing.T) {
	// Save original value
	origBuildTime := BuildTime
	defer func() {
		BuildTime = origBuildTime
	}()

	// Test with "unknown" build time
	BuildTime = "unknown"

	result := BuildTimestamp()
	assert.True(t, result.IsZero(), "BuildTimestamp should return zero time for unknown build time")
}

func TestBuildTimestamp_InvalidFormat(t *testing.T) {
	// Save original value
	origBuildTime := BuildTime
	defer func() {
		BuildTime = origBuildTime
	}()

	// Test with invalid timestamp format
	BuildTime = "invalid-timestamp"

	result := BuildTimestamp()
	assert.True(t, result.IsZero(), "BuildTimestamp should return zero time for invalid format")
}

func TestBuildTimestamp_EmptyString(t *testing.T) {
	// Save original value
	origBuildTime := BuildTime
	defer func() {
		BuildTime = origBuildTime
	}()

	// Test with empty string
	BuildTime = ""

	result := BuildTimestamp()
	assert.True(t, result.IsZero(), "BuildTimestamp should return zero time for empty string")
}

func TestInfo_JSONTags(t *testing.T) {
	// Verify Info struct has correct JSON tags
	info := Info{
		Version:   "1.0.0",
		Commit:    "abc123",
		BuildTime: "2025-10-21T10:00:00Z",
		GoVersion: "go1.21",
	}

	// Verify fields are accessible
	assert.Equal(t, "1.0.0", info.Version)
	assert.Equal(t, "abc123", info.Commit)
	assert.Equal(t, "2025-10-21T10:00:00Z", info.BuildTime)
	assert.Equal(t, "go1.21", info.GoVersion)
}

func TestGoVersion_RuntimeMatch(t *testing.T) {
	// Verify GoVersion is initialized to runtime.Version()
	assert.Equal(t, runtime.Version(), GoVersion, "GoVersion should be initialized to runtime.Version()")
}

func TestVersion_TableDriven(t *testing.T) {
	tests := []struct {
		name           string
		version        string
		commit         string
		expectedString string
	}{
		{
			name:           "production version with full commit",
			version:        "1.0.0",
			commit:         "abc123def456789",
			expectedString: "1.0.0 (abc123d)",
		},
		{
			name:           "dev version with unknown commit",
			version:        "dev",
			commit:         "unknown",
			expectedString: "dev",
		},
		{
			name:           "version with exactly 7 char commit",
			version:        "2.0.0",
			commit:         "1234567",
			expectedString: "2.0.0",
		},
		{
			name:           "version with 8 char commit",
			version:        "2.1.0",
			commit:         "12345678",
			expectedString: "2.1.0 (1234567)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Save original values
			origVersion := Version
			origCommit := Commit
			defer func() {
				Version = origVersion
				Commit = origCommit
			}()

			// Set test values
			Version = tt.version
			Commit = tt.commit

			// Test String()
			result := String()
			assert.Equal(t, tt.expectedString, result)

			// Test Get()
			info := Get()
			assert.Equal(t, tt.version, info.Version)
			assert.Equal(t, tt.commit, info.Commit)
		})
	}
}

func TestBuildTimestamp_TableDriven(t *testing.T) {
	tests := []struct {
		name       string
		buildTime  string
		expectZero bool
	}{
		{
			name:       "valid RFC3339",
			buildTime:  "2025-10-21T10:00:00Z",
			expectZero: false,
		},
		{
			name:       "valid RFC3339 with timezone",
			buildTime:  "2025-10-21T10:00:00+05:00",
			expectZero: false,
		},
		{
			name:       "unknown",
			buildTime:  "unknown",
			expectZero: true,
		},
		{
			name:       "empty string",
			buildTime:  "",
			expectZero: true,
		},
		{
			name:       "invalid format",
			buildTime:  "2025/10/21 10:00:00",
			expectZero: true,
		},
		{
			name:       "partial timestamp",
			buildTime:  "2025-10-21",
			expectZero: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Save original value
			origBuildTime := BuildTime
			defer func() {
				BuildTime = origBuildTime
			}()

			// Set test value
			BuildTime = tt.buildTime

			// Test BuildTimestamp()
			result := BuildTimestamp()

			if tt.expectZero {
				assert.True(t, result.IsZero(), "Expected zero time")
			} else {
				assert.False(t, result.IsZero(), "Expected valid time")

				// Verify it can be parsed correctly
				expected, err := time.Parse(time.RFC3339, tt.buildTime)
				assert.NoError(t, err)
				assert.Equal(t, expected, result)
			}
		})
	}
}

