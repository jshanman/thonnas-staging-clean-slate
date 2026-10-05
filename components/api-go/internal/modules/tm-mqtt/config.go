package tmmqtt

import "time"

// Config represents the MQTT module configuration
// Maps to module.config.yaml structure
type Config struct {
	// Broker connection
	BrokerHost string `json:"brokerHost"`
	BrokerPort int    `json:"brokerPort"`

	// Topic configuration
	TopicPrefix string `json:"topicPrefix"` // Prefix for all published topics
	StatusTopic string `json:"statusTopic"` // Shared subscription for LWT status
	LWTGroup    string `json:"lwtGroup"`    // Shared subscription group name

	// Connection settings
	ClientIdPrefix    string        `json:"clientIdPrefix"`    // Prefix for MQTT client ID
	KeepAlive         time.Duration `json:"keepAlive"`         // Keep-alive interval
	ConnectTimeout    time.Duration `json:"connectTimeout"`    // Connection timeout
	ReconnectDelay    time.Duration `json:"reconnectDelay"`    // Delay between reconnection attempts
	MaxReconnectDelay time.Duration `json:"maxReconnectDelay"` // Maximum reconnection delay
	DefaultQoS        int           `json:"defaultQoS"`        // Default QoS level (0, 1, or 2)
}

// DefaultConfig returns default MQTT configuration
// Fallback values if module config fails to load
func DefaultConfig() Config {
	return Config{
		BrokerHost:        "localhost",
		BrokerPort:        1883,
		TopicPrefix:       "api-go",
		StatusTopic:       "$share/lwt-group/status/+/+/+",
		LWTGroup:          "lwt-group",
		ClientIdPrefix:    "api-go",
		KeepAlive:         60 * time.Second,
		ConnectTimeout:    30 * time.Second,
		ReconnectDelay:    5 * time.Second,
		MaxReconnectDelay: 5 * time.Minute,
		DefaultQoS:        1,
	}
}

