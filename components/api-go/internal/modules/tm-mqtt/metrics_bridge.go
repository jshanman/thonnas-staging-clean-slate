package tmmqtt

import (
	"encoding/json"
	"strings"

	"thonnas/api-go/internal/thonnas/contracts"
)

const mqttMetricsWildcardTopic = "#"

var mqttMetricValueFields = map[string]struct{}{
	"count":     {},
	"value":     {},
	"duration":  {},
	"timestamp": {},
	"data":      {},
}

// RegisterMetricsBridge stages a wildcard MQTT subscription that forwards messages to ThonnasMetrics.
// @intent Bridge MQTT telemetry through contracts.ThonnasMetrics without observe.metrics vendor imports
func RegisterMetricsBridge(metrics contracts.ThonnasMetrics) {
	if metrics == nil {
		return
	}

	DefaultBus.RegisterTopic(mqttMetricsWildcardTopic, 0, FuncHandler(func(topic string, payload []byte) error {
		recordMqttMessageMetric(metrics, topic, payload)
		return nil
	}))
}

func recordMqttMessageMetric(metrics contracts.ThonnasMetrics, topic string, payload []byte) {
	metricName := strings.ReplaceAll(topic, "/", ".")

	var parsed map[string]any
	if err := json.Unmarshal(payload, &parsed); err == nil && len(parsed) > 0 {
		value := float64(1)
		for _, key := range []string{"count", "value", "duration"} {
			if raw, ok := parsed[key]; ok {
				if n, ok := toFloat64(raw); ok {
					value = n
					break
				}
			}
		}

		attrs := contracts.ThonnasAttributes{"topic": topic}
		for key, raw := range parsed {
			if _, skip := mqttMetricValueFields[key]; skip {
				continue
			}
			if s, ok := raw.(string); ok {
				attrs[key] = s
				continue
			}
			if n, ok := toFloat64(raw); ok {
				attrs[key] = n
				continue
			}
			if b, ok := raw.(bool); ok {
				attrs[key] = b
			}
		}

		metrics.RecordCounter(metricName+".gauge", value, attrs)
		return
	}

	var numeric float64
	if err := json.Unmarshal(payload, &numeric); err == nil {
		metrics.RecordCounter(metricName+".gauge", numeric, contracts.ThonnasAttributes{"topic": topic})
		return
	}

	metrics.RecordCounter(metricName+".message", 1, contracts.ThonnasAttributes{"topic": topic})
}

func toFloat64(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	default:
		return 0, false
	}
}

