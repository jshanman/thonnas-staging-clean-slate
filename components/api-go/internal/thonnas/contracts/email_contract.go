package contracts

import "context"

// ThonnasEmailSendOptions mirrors @thonnas/contracts transactional send shape.
type ThonnasEmailSendOptions struct {
	To       string
	Subject  string
	Template string
	Context  map[string]any
}

// ThonnasEmail abstracts SMTP/console/SendGrid behind one injectable (Go uses context for cancellation).
type ThonnasEmail interface {
	SendEmail(ctx context.Context, options ThonnasEmailSendOptions) error
}

