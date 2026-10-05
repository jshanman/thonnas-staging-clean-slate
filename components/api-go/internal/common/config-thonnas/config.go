package configthonnas

import (
	"thonnas/api-go/internal/config"
)

// Provider exposes generated configuration to modules without hardcoding env keys.
type Provider interface {
	// Config returns the full generated configuration tree.
	Config() *config.Config
}

// Wrapper implements Provider around the generated config struct.
type Wrapper struct {
	cfg *config.Config
}

// NewWrapper builds a provider from the generated config. Passing nil yields an empty config.
func NewWrapper(cfg *config.Config) *Wrapper {
	if cfg == nil {
		cfg = &config.Config{}
	}
	return &Wrapper{cfg: cfg}
}

// Config returns the underlying generated configuration.
func (w *Wrapper) Config() *config.Config {
	return w.cfg
}

