package tmmqtt

import (
	"thonnas/api-go/internal/common/logger"
)

// ClientType represents the type of MQTT client to create
type ClientType string

const (
	// PahoClientType uses Eclipse Paho MQTT client
	PahoClientType ClientType = "paho"
	// MockClientType uses mock client for testing
	MockClientType ClientType = "mock"
)

// ClientFactory creates MQTT clients based on type
type ClientFactory struct {
	logger *logger.Logger
}

// NewClientFactory creates a new MQTT client factory
func NewClientFactory(logger *logger.Logger) *ClientFactory {
	return &ClientFactory{
		logger: logger,
	}
}

// CreateClient creates an MQTT client of the specified type
func (f *ClientFactory) CreateClient(clientType ClientType, config *MQTTConfig) (MQTTClient, error) {
	switch clientType {
	case PahoClientType:
		return NewPahoMQTTClient(config, f.logger)
	case MockClientType:
		return NewMockMQTTClient(f.logger), nil
	default:
		return nil, &UnsupportedClientTypeError{ClientType: string(clientType)}
	}
}

// UnsupportedClientTypeError is returned when an unsupported client type is requested
type UnsupportedClientTypeError struct {
	ClientType string
}

func (e *UnsupportedClientTypeError) Error() string {
	return "unsupported MQTT client type: " + e.ClientType
}


