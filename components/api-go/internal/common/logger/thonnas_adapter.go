package logger

import (
	"thonnas/api-go/internal/thonnas/contracts"
)

// ThonnasLoggerAdapter bridges contracts.ThonnasLogger to structured logrus output.
//
// @intent Same role as Nest nest-tm-logger.adapter / tm-user-logger adapter
type ThonnasLoggerAdapter struct {
	base *Logger
}

// NewThonnasLoggerAdapter wraps the application Logger for Thonnas contract calls.
func NewThonnasLoggerAdapter(base *Logger) *ThonnasLoggerAdapter {
	return &ThonnasLoggerAdapter{base: base}
}

func attrsToMap(a contracts.ThonnasAttributes) map[string]interface{} {
	if len(a) == 0 {
		return nil
	}
	m := make(map[string]interface{}, len(a))
	for k, v := range a {
		m[k] = v
	}
	return m
}

func (a *ThonnasLoggerAdapter) Debug(message string, attributes contracts.ThonnasAttributes) {
	a.base.WithFields(attrsToMap(attributes)).Debug(message)
}

func (a *ThonnasLoggerAdapter) Info(message string, attributes contracts.ThonnasAttributes) {
	a.base.WithFields(attrsToMap(attributes)).Info(message)
}

func (a *ThonnasLoggerAdapter) Warn(message string, attributes contracts.ThonnasAttributes) {
	a.base.WithFields(attrsToMap(attributes)).Warn(message)
}

func (a *ThonnasLoggerAdapter) Error(message string, attributes contracts.ThonnasAttributes) {
	a.base.WithFields(attrsToMap(attributes)).Error(message)
}

