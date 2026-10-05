package tmmqtt

import (
	"testing"

	"thonnas/api-go/internal/thonnas/contracts"
)

type recordingMetrics struct {
	name       string
	value      float64
	attributes contracts.ThonnasAttributes
}

type mockThonnasMetrics struct {
	records []recordingMetrics
}

func (m *mockThonnasMetrics) RecordCounter(name string, value float64, attributes contracts.ThonnasAttributes) {
	m.records = append(m.records, recordingMetrics{name: name, value: value, attributes: attributes})
}

func (m *mockThonnasMetrics) AddEvent(_ string, _ contracts.ThonnasAttributes) {}

func TestRecordMqttMessageMetric_ObjectPayload(t *testing.T) {
	metrics := &mockThonnasMetrics{}

	recordMqttMessageMetric(metrics, "users/count", []byte(`{"count":5,"region":"us"}`))

	if len(metrics.records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(metrics.records))
	}
	record := metrics.records[0]
	if record.name != "users.count.gauge" {
		t.Fatalf("unexpected metric name: %s", record.name)
	}
	if record.value != 5 {
		t.Fatalf("unexpected metric value: %v", record.value)
	}
	if record.attributes["topic"] != "users/count" {
		t.Fatalf("unexpected topic attribute: %v", record.attributes["topic"])
	}
	if record.attributes["region"] != "us" {
		t.Fatalf("unexpected region attribute: %v", record.attributes["region"])
	}
}

func TestRecordMqttMessageMetric_NonObjectPayload(t *testing.T) {
	metrics := &mockThonnasMetrics{}

	recordMqttMessageMetric(metrics, "events/ping", []byte(`"ok"`))

	if len(metrics.records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(metrics.records))
	}
	record := metrics.records[0]
	if record.name != "events.ping.message" {
		t.Fatalf("unexpected metric name: %s", record.name)
	}
	if record.value != 1 {
		t.Fatalf("unexpected metric value: %v", record.value)
	}
}

func TestRegisterMetricsBridge_NilMetrics(t *testing.T) {
	bus := NewRegistrationBus()
	oldBus := DefaultBus
	DefaultBus = bus
	defer func() { DefaultBus = oldBus }()

	RegisterMetricsBridge(nil)

	if len(bus.topicRegs) != 0 {
		t.Fatalf("expected no topic registrations for nil metrics, got %d", len(bus.topicRegs))
	}
}

