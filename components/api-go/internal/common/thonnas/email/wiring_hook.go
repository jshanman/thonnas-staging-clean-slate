package thonnasemail

import (
	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/thonnas/contracts"
)

// EmailBuild wires transactional email (tm-email strategy). Nil → noop until an installer registers SMTP/API.
//
// @intent Mirror Nest thonnas-email.impl.ts IMPL hook
var EmailBuild func(log *logger.Logger) contracts.ThonnasEmail

// ResolveThonnasEmail returns wired email contract or noop.
func ResolveThonnasEmail(log *logger.Logger) contracts.ThonnasEmail {
	if EmailBuild != nil {
		return EmailBuild(log)
	}
	return NoopThonnasEmail{}
}

