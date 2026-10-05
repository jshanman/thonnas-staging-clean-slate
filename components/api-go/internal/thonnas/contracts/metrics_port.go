package contracts

// ThonnasAttributes mirrors @thonnas/contracts ThonnasAttributes (JSON-serializable values).
type ThonnasAttributes map[string]any

// ThonnasMetrics is the portable metrics contract (counters + span-like events) without OTEL imports in callers.
type ThonnasMetrics interface {
	RecordCounter(name string, value float64, attributes ThonnasAttributes)
	AddEvent(name string, attributes ThonnasAttributes)
}

