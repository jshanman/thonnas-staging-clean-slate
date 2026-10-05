package tmmqtt

import (
	"encoding/json"
	"fmt"
	"time"

	"thonnas/api-go/internal/common/logger"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// PahoMQTTClient wraps the Eclipse Paho MQTT client
type PahoMQTTClient struct {
	client mqtt.Client
	logger *logger.Logger
	config *MQTTConfig
}

// NewPahoMQTTClient creates a new MQTT client using Eclipse Paho
func NewPahoMQTTClient(config *MQTTConfig, log *logger.Logger) (MQTTClient, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(fmt.Sprintf("tcp://%s:%d", config.BrokerHost, config.BrokerPort))
	opts.SetClientID(config.ClientID)
	opts.SetCleanSession(config.CleanSession)
	opts.SetProtocolVersion(4)
	opts.SetKeepAlive(time.Duration(config.KeepAlive) * time.Second)
	opts.SetConnectTimeout(time.Duration(config.ConnectTimeout) * time.Second)
	opts.SetAutoReconnect(config.AutoReconnect)
	opts.SetMaxReconnectInterval(time.Duration(config.MaxReconnectInterval) * time.Second)

	// Set authentication if provided
	if config.Username != "" {
		opts.SetUsername(config.Username)
	}
	if config.Password != "" {
		opts.SetPassword(config.Password)
	}

	// Set connection lost handler
	opts.SetConnectionLostHandler(func(client mqtt.Client, err error) {
		log.WithFields(map[string]interface{}{
			"error": err.Error(),
		}).Error("MQTT connection lost")
	})

	// Set reconnect handler
	opts.SetOnConnectHandler(func(client mqtt.Client) {
		log.Info("MQTT client reconnected")
	})

	client := mqtt.NewClient(opts)

	// Connect to broker
	token := client.Connect()
	if token.Wait() && token.Error() != nil {
		return nil, fmt.Errorf("failed to connect to MQTT broker: %w", token.Error())
	}

	log.WithFields(map[string]interface{}{
		"broker":    fmt.Sprintf("%s:%d", config.BrokerHost, config.BrokerPort),
		"client_id": config.ClientID,
	}).Info("Connected to MQTT broker")

	return &PahoMQTTClient{
		client: client,
		logger: log,
		config: config,
	}, nil
}

// Publish publishes a message to an MQTT topic
func (c *PahoMQTTClient) Publish(topic string, qos byte, retained bool, payload interface{}) error {
	c.logger.WithFields(map[string]interface{}{
		"topic":     topic,
		"qos":       qos,
		"connected": c.client.IsConnected(),
	}).Debug("Publishing MQTT message")

	var payloadBytes []byte
	var err error

	// Convert payload to bytes
	switch v := payload.(type) {
	case []byte:
		payloadBytes = v
	case string:
		payloadBytes = []byte(v)
	default:
		// JSON marshal for complex types
		payloadBytes, err = json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("failed to marshal payload: %w", err)
		}
	}

	token := c.client.Publish(topic, qos, retained, payloadBytes)
	if token.Wait() && token.Error() != nil {
		c.logger.WithFields(map[string]interface{}{
			"topic": topic,
			"error": token.Error().Error(),
		}).Error("Failed to publish MQTT message")
		return fmt.Errorf("failed to publish message: %w", token.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"topic":        topic,
		"qos":          qos,
		"retained":     retained,
		"payload_size": len(payloadBytes),
	}).Debug("MQTT message published successfully")
	return nil
}

// Subscribe subscribes to an MQTT topic
func (c *PahoMQTTClient) Subscribe(topic string, qos byte, handler MessageHandler) error {
	c.logger.WithFields(map[string]interface{}{
		"topic": topic,
		"qos":   qos,
	}).Info("Subscribing to MQTT topic")

	token := c.client.Subscribe(topic, qos, func(client mqtt.Client, msg mqtt.Message) {
		handler(msg.Topic(), msg.Payload())
	})

	if token.Wait() && token.Error() != nil {
		c.logger.WithFields(map[string]interface{}{
			"topic": topic,
			"error": token.Error().Error(),
		}).Error("Failed to subscribe to MQTT topic")
		return fmt.Errorf("failed to subscribe to topic: %w", token.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"topic": topic,
		"qos":   qos,
	}).Info("Successfully subscribed to MQTT topic")
	return nil
}

// Unsubscribe unsubscribes from an MQTT topic
func (c *PahoMQTTClient) Unsubscribe(topic string) error {
	c.logger.WithFields(map[string]interface{}{
		"topic": topic,
	}).Info("Unsubscribing from MQTT topic")

	token := c.client.Unsubscribe(topic)
	if token.Wait() && token.Error() != nil {
		c.logger.WithFields(map[string]interface{}{
			"topic": topic,
			"error": token.Error().Error(),
		}).Error("Failed to unsubscribe from MQTT topic")
		return fmt.Errorf("failed to unsubscribe from topic: %w", token.Error())
	}

	c.logger.WithFields(map[string]interface{}{
		"topic": topic,
	}).Info("Successfully unsubscribed from MQTT topic")
	return nil
}

// IsConnected returns whether the client is connected
func (c *PahoMQTTClient) IsConnected() bool {
	return c.client.IsConnected()
}

// Close closes the MQTT connection
func (c *PahoMQTTClient) Close() {
	if c.client != nil && c.client.IsConnected() {
		c.client.Disconnect(250)
		c.logger.Info("Disconnected from MQTT broker")
	}
}

