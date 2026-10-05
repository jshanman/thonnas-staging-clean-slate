package thonnasevents

import (
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/thonnas/contracts"
)

// EventsBuild wires pub/sub transport (e.g. tm-events). Nil → noop.
//
// @intent Mirror Nest thonnas-events.impl.ts IMPL hook
var EventsBuild func(log *logger.Logger) contracts.ThonnasEvents

// ResolveThonnasEvents returns wired events contract or noop.
func ResolveThonnasEvents(log *logger.Logger) contracts.ThonnasEvents {
	if EventsBuild != nil {
		return EventsBuild(log)
	}
	return NoopThonnasEvents{}
}

