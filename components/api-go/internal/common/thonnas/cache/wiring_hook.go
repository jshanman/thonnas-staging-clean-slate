package thonnascache

import "thonnas/api-go/internal/common/logger"

// CacheProviderBuild is set by vendor *.wiring.* packages or optional cache installers.
// When nil, ResolveCacheProvider uses NewNoOpCacheProvider only (bare component / tests).
//
// @intent Mirror Nest thonnas-cache.impl.ts IMPL hook — installers register real backends here
var CacheProviderBuild func(log *logger.Logger, cfg *CacheConfig) (CacheProvider, error)

// ResolveCacheProvider applies CacheProviderBuild or falls back to noop.
func ResolveCacheProvider(log *logger.Logger, cfg *CacheConfig) (CacheProvider, error) {
	if CacheProviderBuild != nil {
		return CacheProviderBuild(log, cfg)
	}
	log.Info("Cache wiring not registered; using Thonnas cache noop")
	return NewNoOpCacheProvider(), nil
}

