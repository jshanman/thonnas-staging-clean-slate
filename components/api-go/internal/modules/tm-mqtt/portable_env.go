package tmmqtt

import (
	"os"
	"strings"
)

// @intent infra-cdk's MqttFleetToEcs wires THONNAS_MQTT_USERNAME/PASSWORD into every backend
// consumer from the fleet's own broker-admin secret (never the browser-scoped
// QUEUE_MQTT_FRONTEND_* credential) -- same portable-contract precedence tm-cache-redis's
// resolveRedisTarget already established for THONNAS_CACHE_*. Backend services connect
// anonymously only when the fleet has no authentication configured at all.
func resolveMqttCredentials(getenv func(string) string) (username, password string) {
	return strings.TrimSpace(getenv("THONNAS_MQTT_USERNAME")), strings.TrimSpace(getenv("THONNAS_MQTT_PASSWORD"))
}

var osGetenv = os.Getenv

