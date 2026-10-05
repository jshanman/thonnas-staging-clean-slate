package thonnascache

import (
	"time"

	"thonnas/api-go/internal/config"
	"thonnas/api-go/internal/thonnas/contracts"
)

// CacheProvider is the extended backend used only inside common/thonnas wiring and optional cache installers.
// Application modules must depend on contracts.ThonnasCache (via ctx.Contracts.ThonnasCache), not this type.
//
// @intent Portable cache backend surface — never inject into feature modules directly
type CacheProvider interface {
	contracts.ThonnasCache
	Close() error
}

// CacheConfig holds configuration for cache provider wiring.
type CacheConfig struct {
	Provider string
	Enabled  bool
	Host     string
	Port     int
	Password string

	DialTimeout     time.Duration
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	PoolSize        int
	MinIdleConns    int
	PoolTimeout     time.Duration
	MaxRetries      int
	MinRetryBackoff time.Duration
	MaxRetryBackoff time.Duration
}

// cacheConfigEnv selects the generated config block for cache wiring (noop baseline uses cfg.Cache).
func cacheConfigEnv(cfg *config.Config) config.CacheConfig {
	return cfg.Cache
}

// LoadCacheConfig maps generated config into cache provider wiring.
func LoadCacheConfig(cfg *config.Config) *CacheConfig {
	rc := cacheConfigEnv(cfg)
	return &CacheConfig{
		Provider:        rc.Provider,
		Enabled:         rc.Enabled,
		Host:            rc.Host,
		Port:            rc.Port,
		Password:        rc.Password,
		DialTimeout:     rc.Dialtimeout,
		ReadTimeout:     rc.Readtimeout,
		WriteTimeout:    rc.Writetimeout,
		PoolSize:        rc.Poolsize,
		MinIdleConns:    rc.Minidleconns,
		PoolTimeout:     rc.Pooltimeout,
		MaxRetries:      rc.Maxretries,
		MinRetryBackoff: rc.Minretrybackoff,
		MaxRetryBackoff: rc.Maxretrybackoff,
	}
}

