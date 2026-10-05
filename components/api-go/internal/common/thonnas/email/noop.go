package thonnasemail

import (
	"context"

	"thonnas/api-go/internal/thonnas/contracts"
)

// NoopThonnasEmail implements contracts.ThonnasEmail without sending.
type NoopThonnasEmail struct{}

func (NoopThonnasEmail) SendEmail(ctx context.Context, options contracts.ThonnasEmailSendOptions) error {
	return nil
}

