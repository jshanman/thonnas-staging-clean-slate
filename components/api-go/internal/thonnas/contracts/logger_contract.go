package contracts

// ThonnasLogger mirrors @thonnas/contracts ThonnasLogger (structured fields without framework types).
type ThonnasLogger interface {
	Debug(message string, attributes ThonnasAttributes)
	Info(message string, attributes ThonnasAttributes)
	Warn(message string, attributes ThonnasAttributes)
	Error(message string, attributes ThonnasAttributes)
}

