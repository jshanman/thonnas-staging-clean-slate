package logger

import (
	thonnaslogger "thonnas/api-go/internal/common/thonnas/logger"
	"thonnas/api-go/internal/thonnas/contracts"
)

func init() {
	// @intent Bind observe.logging.structured-style sink for ThonnasLogger contract (api-nest parity)
	thonnaslogger.LoggerBuild = func(appLog interface{}) contracts.ThonnasLogger {
		return NewThonnasLoggerAdapter(appLog.(*Logger))
	}
}

