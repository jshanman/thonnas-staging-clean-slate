package thonnaslogger

import (
	"thonnas/api-go/internal/thonnas/contracts"
)

// LoggerBuild is set by vendor wiring (e.g. common/logger register_thonnas_wiring.go).
// Uses interface{} to avoid an import cycle with package logger (Thonnas imports wiring side-effects).
//
// @intent Mirror Nest thonnas-logger.impl.ts IMPL hook
var LoggerBuild func(appLog interface{}) contracts.ThonnasLogger

// ResolveThonnasLogger returns wired logger contract or noop.
func ResolveThonnasLogger(appLog interface{}) contracts.ThonnasLogger {
	if LoggerBuild != nil {
		return LoggerBuild(appLog)
	}
	return NoopThonnasLogger{}
}

