package tmmqtt

import "testing"

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestResolveMqttCredentialsFromPortableContract(t *testing.T) {
	username, password := resolveMqttCredentials(envOf(map[string]string{
		"THONNAS_MQTT_USERNAME": "thonnas",
		"THONNAS_MQTT_PASSWORD": "s3cret",
	}))
	if username != "thonnas" || password != "s3cret" {
		t.Fatalf("got username=%q password=%q, want thonnas/s3cret", username, password)
	}
}

func TestResolveMqttCredentialsEmptyWhenUnset(t *testing.T) {
	username, password := resolveMqttCredentials(envOf(nil))
	if username != "" || password != "" {
		t.Fatalf("got username=%q password=%q, want both empty", username, password)
	}
}

