package tmmqtt

// MQTTClient defines the interface for MQTT operations
type MQTTClient interface {
	// Publish publishes a message to an MQTT topic
	Publish(topic string, qos byte, retained bool, payload interface{}) error

	// Subscribe subscribes to an MQTT topic
	Subscribe(topic string, qos byte, handler MessageHandler) error

	// Unsubscribe unsubscribes from an MQTT topic
	Unsubscribe(topic string) error

	// IsConnected returns whether the client is connected to the broker
	IsConnected() bool

	// Close closes the MQTT connection
	Close()
}

// MessageHandler defines the function signature for handling received MQTT messages
type MessageHandler func(topic string, payload []byte)

// MessageHandlerI provides typed handler support without exposing concrete module types
type MessageHandlerI interface {
	Handle(topic string, payload []byte) error
}

// FuncHandler adapts a function to MessageHandlerI
type FuncHandler func(topic string, payload []byte) error

func (f FuncHandler) Handle(topic string, payload []byte) error { return f(topic, payload) }

// MQTTConfig contains configuration for MQTT client
type MQTTConfig struct {
	// BrokerHost is the MQTT broker hostname
	BrokerHost string

	// BrokerPort is the MQTT broker port
	BrokerPort int

	// ClientID is the unique client identifier
	ClientID string

	// Username for authentication (optional)
	Username string

	// Password for authentication (optional)
	Password string

	// CleanSession indicates whether to use clean session
	CleanSession bool

	// KeepAlive is the keep alive interval in seconds
	KeepAlive int

	// ConnectTimeout is the connection timeout
	ConnectTimeout int

	// AutoReconnect indicates whether to automatically reconnect
	AutoReconnect bool

	// MaxReconnectInterval is the maximum time between reconnection attempts
	MaxReconnectInterval int
}

// SubscriberRegistrar allows feature modules to stage MQTT subscriptions
type SubscriberRegistrar interface {
	Register(client MQTTClient) error
	Stop() error
}

// RegistrationBus stores registrars until MQTT client is ready
type RegistrationBus struct {
	registrars []SubscriberRegistrar
	topicRegs  []struct {
		topic   string
		qos     byte
		handler MessageHandlerI
	}
}

func NewRegistrationBus() *RegistrationBus {
	return &RegistrationBus{registrars: make([]SubscriberRegistrar, 0), topicRegs: make([]struct {
		topic   string
		qos     byte
		handler MessageHandlerI
	}, 0)}
}

// DefaultBus is a package-level bus for modules to register into without main awareness
var DefaultBus = NewRegistrationBus()

// Register stages a registrar to be committed later
func (b *RegistrationBus) Register(reg SubscriberRegistrar) {
	if b == nil || reg == nil {
		return
	}
	b.registrars = append(b.registrars, reg)
}

// RegisterTopic stages a topic + typed handler to be subscribed at commit time
func (b *RegistrationBus) RegisterTopic(topic string, qos byte, handler MessageHandlerI) {
	if b == nil || handler == nil {
		return
	}
	b.topicRegs = append(b.topicRegs, struct {
		topic   string
		qos     byte
		handler MessageHandlerI
	}{topic: topic, qos: qos, handler: handler})
}

// Commit calls Register(client) on all staged registrars
func (b *RegistrationBus) Commit(client MQTTClient) error {
	if b == nil {
		return nil
	}
	for _, r := range b.registrars {
		if err := r.Register(client); err != nil {
			return err
		}
	}
	for _, tr := range b.topicRegs {
		h := tr.handler
		// adapt to function handler expected by client
		if err := client.Subscribe(tr.topic, tr.qos, func(topic string, payload []byte) {
			_ = h.Handle(topic, payload)
		}); err != nil {
			return err
		}
	}
	return nil
}

// ClientStatus represents the status of a connected client
type ClientStatus struct {
	ClientID   string  `json:"clientId"`
	IdentityID string  `json:"identityId"`
	UserID     *string `json:"userId,omitempty"`
	Component  string  `json:"component"`
	Status     string  `json:"status"` // "online" or "offline"
	LastSeen   string  `json:"lastSeen"`
	Reason     string  `json:"reason,omitempty"`
}


