package contracts

import "context"

// ThonnasCache is the portable distributed cache contract (set ops for presence/counting without Redis imports in callers).
type ThonnasCache interface {
	SetAdd(ctx context.Context, key string, member string) error
	SetRemove(ctx context.Context, key string, member string) error
	SetCardinality(ctx context.Context, key string) (int, error)
}

