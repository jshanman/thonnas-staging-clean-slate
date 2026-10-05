package tmmqtt

import (
    "sync"
    "testing"
)

// mockClient captures subscriptions for verification
type mockClient struct {
    subsMu sync.Mutex
    subs   []struct{ topic string; qos byte; handler MessageHandler }
}

func (m *mockClient) Publish(topic string, qos byte, retained bool, payload interface{}) error { return nil }
func (m *mockClient) Subscribe(topic string, qos byte, handler MessageHandler) error {
    m.subsMu.Lock()
    defer m.subsMu.Unlock()
    m.subs = append(m.subs, struct{ topic string; qos byte; handler MessageHandler }{topic, qos, handler})
    return nil
}
func (m *mockClient) Unsubscribe(topic string) error { return nil }
func (m *mockClient) IsConnected() bool { return true }
func (m *mockClient) Close() {}

func TestRegistrationBus_Commit_TopicHandlers(t *testing.T) {
    bus := NewRegistrationBus()
    // stage two topics
    bus.RegisterTopic("status/user/+/+", 1, FuncHandler(func(topic string, payload []byte) error { return nil }))
    bus.RegisterTopic("status/sys/+/+", 1, FuncHandler(func(topic string, payload []byte) error { return nil }))

    mc := &mockClient{}
    if err := bus.Commit(mc); err != nil {
        t.Fatalf("commit error: %v", err)
    }

    mc.subsMu.Lock()
    defer mc.subsMu.Unlock()
    if len(mc.subs) != 2 {
        t.Fatalf("expected 2 subs, got %d", len(mc.subs))
    }
    if mc.subs[0].topic == mc.subs[1].topic {
        t.Fatalf("topics should differ")
    }
}



