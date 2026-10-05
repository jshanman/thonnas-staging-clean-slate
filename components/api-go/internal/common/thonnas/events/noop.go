package thonnasevents

import (
	"context"

	"thonnas/api-go/internal/thonnas/contracts"
)

// NoopThonnasEvents implements contracts.ThonnasEvents without publishing.
type NoopThonnasEvents struct{}

func (NoopThonnasEvents) Publish(ctx context.Context, envelope contracts.DomainEventEnvelope) error {
	return nil
}

