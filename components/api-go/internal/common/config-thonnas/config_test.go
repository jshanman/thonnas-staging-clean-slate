package configthonnas

import (
	"testing"
	"thonnas/api-go/internal/config"
)

func TestWrapper(t *testing.T) {
	w := NewWrapper(nil)
	if w.Config() == nil {
		t.Fatalf("expected non-nil config even when constructed with nil")
	}

	cfg := &config.Config{
		App: config.AppConfig{Servicename: "api-go"},
	}
	w = NewWrapper(cfg)
	if got := w.Config().App.Servicename; got != "api-go" {
		t.Fatalf("expected service name to propagate, got %s", got)
	}
}

