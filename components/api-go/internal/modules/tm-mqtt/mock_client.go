package tmmqtt

import (
	"thonnas/api-go/internal/common/logger"
)

// MockMQTTClient for testing without MQTT broker
type MockMQTTClient struct {
	logger     *logger.Logger
	publish    bool
	subscribe  bool
	connected  bool
	subscribers map[string]MessageHandler
}

// NewMockMQTTClient creates a mock MQTT client
func NewMockMQTTClient(log *logger.Logger) MQTTClient {
	return &MockMQTTClient{
		logger:      log,
		publish:     true,
		subscribe:   true,
		connected:   true,
		subscribers: make(map[string]MessageHandler),
	}
}

// Publish logs the message instead of publishing
func (m *MockMQTTClient) Publish(topic string, qos byte, retained bool, payload interface{}) error {
	if !m.publish {
		return nil
	}

	m.logger.WithFields(map[string]interface{}{
		"topic":    topic,
		"qos":      qos,
		"retained": retained,
		"payload":  payload,
	}).Info("Mock MQTT: Would publish message")

	return nil
}

// Subscribe logs the subscription instead of actually subscribing
func (m *MockMQTTClient) Subscribe(topic string, qos byte, handler MessageHandler) error {
	if !m.subscribe {
		return nil
	}

	m.logger.WithFields(map[string]interface{}{
		"topic": topic,
		"qos":   qos,
	}).Info("Mock MQTT: Would subscribe to topic")

	m.subscribers[topic] = handler
	return nil
}

// Unsubscribe logs the unsubscription instead of actually unsubscribing
func (m *MockMQTTClient) Unsubscribe(topic string) error {
	m.logger.WithFields(map[string]interface{}{
		"topic": topic,
	}).Info("Mock MQTT: Would unsubscribe from topic")

	delete(m.subscribers, topic)
	return nil
}

// IsConnected returns the mock connection status
func (m *MockMQTTClient) IsConnected() bool {
	return m.connected
}

// Close logs the close operation
func (m *MockMQTTClient) Close() {
	m.logger.Info("Mock MQTT: Client closed")
	m.connected = false
}

// SimulateMessage simulates receiving a message on a topic (for testing)
func (m *MockMQTTClient) SimulateMessage(topic string, payload []byte) {
	if handler, exists := m.subscribers[topic]; exists {
		handler(topic, payload)
	}
}

// SetPublishEnabled enables or disables publishing for testing
func (m *MockMQTTClient) SetPublishEnabled(enabled bool) {
	m.publish = enabled
}

// SetSubscribeEnabled enables or disables subscribing for testing
func (m *MockMQTTClient) SetSubscribeEnabled(enabled bool) {
	m.subscribe = enabled
}

// SetConnected sets the mock connection status
func (m *MockMQTTClient) SetConnected(connected bool) {
	m.connected = connected
}


