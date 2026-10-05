package tmmqtt

import (
	"context"
	"fmt"
	"time"

	"thonnas/api-go/internal/common/logger"
	"thonnas/api-go/internal/config"

	"github.com/patrickmn/go-cache"
)

// Module represents the MQTT module
type Module struct {
	client MQTTClient
	logger *logger.Logger
	config MQTTConfig
}

// NewModule creates a new MQTT module
func NewModule(log *logger.Logger, cfg *config.Config, cache *cache.Cache) (*Module, error) {
	// Get module configuration from generated config (already merged and type-safe)
	mqttCfg := cfg.TmMqtt

	username, password := resolveMqttCredentials(osGetenv)

	log.WithFields(map[string]interface{}{
		"brokerHost":  mqttCfg.Brokerhost,
		"brokerPort":  mqttCfg.Brokerport,
		"topicPrefix": mqttCfg.Topicprefix,
		"auth":        username != "",
	}).Info("MQTT module configured")

	// Generate a unique client ID for this API-Go instance
	clientID := fmt.Sprintf("%s-%d", mqttCfg.Clientidprefix, time.Now().Unix())

	mqttConfig := MQTTConfig{
		BrokerHost:           mqttCfg.Brokerhost,
		BrokerPort:           mqttCfg.Brokerport,
		ClientID:             clientID,
		Username:             username,
		Password:             password,
		CleanSession:         true,
		KeepAlive:            int(mqttCfg.Keepalive.Seconds()),
		ConnectTimeout:       int(mqttCfg.Connecttimeout.Seconds()),
		AutoReconnect:        true,
		MaxReconnectInterval: int(mqttCfg.Maxreconnectdelay.Seconds()),
	}

	log.WithFields(map[string]interface{}{
		"clientID":   clientID,
		"brokerHost": mqttCfg.Brokerhost,
		"brokerPort": mqttCfg.Brokerport,
	}).Info("Attempting MQTT connection")

	client, err := NewPahoMQTTClient(&mqttConfig, log)
	if err != nil {
		log.WithFields(map[string]interface{}{
			"error": err.Error(),
		}).Error("Failed to create MQTT client")
		return nil, fmt.Errorf("mqtt module: %w", err)
	}
	return &Module{
		client: client,
		logger: log,
		config: mqttConfig,
	}, nil
}

// Start starts the MQTT module
func (m *Module) Start(ctx context.Context) error {
	m.logger.Info("Starting MQTT Module")

	// Commit all staged MQTT registrars now that the client exists
	if err := DefaultBus.Commit(m.client); err != nil {
		return fmt.Errorf("failed to commit MQTT registrars: %w", err)
	}

	m.logger.Info("MQTT Module started successfully")
	return nil
}

// Stop stops the MQTT module
func (m *Module) Stop() error {
	m.logger.Info("Stopping MQTT Module")

	// Close MQTT client
	m.client.Close()

	m.logger.Info("MQTT Module stopped")
	return nil
}

// GetClient returns the MQTT client
func (m *Module) GetClient() MQTTClient {
	return m.client
}

// (LWT handler removed)

// IsConnected returns whether the MQTT client is connected
func (m *Module) IsConnected() bool {
	return m.client.IsConnected()
}

