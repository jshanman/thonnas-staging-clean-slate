package version

import (
	"runtime"
	"time"
)

var (
	// These variables are set at build time via -ldflags
	// Example: go build -ldflags "-X thonnas/api-go/internal/common/version.Version=1.0.0"
	Version   = "dev"      // Semantic version (e.g., "1.0.0")
	Commit    = "unknown"  // Git commit hash
	BuildTime = "unknown"  // Build timestamp
	GoVersion = runtime.Version() // Go version used to build
)

// Info holds all version information
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
	GoVersion string `json:"goVersion"`
}

// Get returns the complete version information
func Get() Info {
	return Info{
		Version:   Version,
		Commit:    Commit,
		BuildTime: BuildTime,
		GoVersion: GoVersion,
	}
}

// String returns a formatted version string
func String() string {
	if Commit != "unknown" && len(Commit) > 7 {
		// Short commit hash (first 7 chars)
		return Version + " (" + Commit[:7] + ")"
	}
	return Version
}

// BuildTimestamp returns the build time as a time.Time
// Returns zero time if build time is unknown
func BuildTimestamp() time.Time {
	if BuildTime == "unknown" {
		return time.Time{}
	}
	
	t, err := time.Parse(time.RFC3339, BuildTime)
	if err != nil {
		return time.Time{}
	}
	
	return t
}




