package thonnaslogger

import "thonnas/api-go/internal/thonnas/contracts"

// NoopThonnasLogger implements contracts.ThonnasLogger without output (bare component default).
type NoopThonnasLogger struct{}

func (NoopThonnasLogger) Debug(message string, attributes contracts.ThonnasAttributes) {}
func (NoopThonnasLogger) Info(message string, attributes contracts.ThonnasAttributes)  {}
func (NoopThonnasLogger) Warn(message string, attributes contracts.ThonnasAttributes)  {}
func (NoopThonnasLogger) Error(message string, attributes contracts.ThonnasAttributes) {}

