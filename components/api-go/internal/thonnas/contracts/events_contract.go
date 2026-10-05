package contracts

import "context"

// DomainEventEnvelope mirrors @thonnas/contracts publish-only envelope (payload is JSON-serializable).
type DomainEventEnvelope struct {
	EventType     string
	AggregateID   string
	Payload       any
	OccurredAt    string
	CorrelationID string
}

// ThonnasEvents is the portable publish entry point for domain events.
type ThonnasEvents interface {
	Publish(ctx context.Context, envelope DomainEventEnvelope) error
}

