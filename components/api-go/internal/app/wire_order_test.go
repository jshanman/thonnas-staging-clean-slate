package app

import (
	"testing"

	"thonnas/api-go/internal/appmodule"
)

func TestDeferWireLastModules(t *testing.T) {
	health := &ModuleMetadata{Name: "health"}
	mqtt := &ModuleMetadata{Name: "mqtt"}
	usercount := &ModuleMetadata{Name: "usercount", Imports: []string{"mqtt"}}
	worker := &ModuleMetadata{Name: "worker", WireLast: true}

	ordered := []*ModuleMetadata{health, worker, mqtt, usercount}
	got := deferWireLastModules(ordered)

	want := []string{"health", "mqtt", "usercount", "worker"}
	if len(got) != len(want) {
		t.Fatalf("got %d modules, want %d", len(got), len(want))
	}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("position %d: got %q, want %q", i, got[i].Name, name)
		}
	}
}

func TestDeferWireLastModulesPreservesWireLastOrder(t *testing.T) {
	first := &ModuleMetadata{Name: "a", WireLast: true}
	second := &ModuleMetadata{Name: "b", WireLast: true}
	got := deferWireLastModules([]*ModuleMetadata{{Name: "core"}, first, second})
	if got[1].Name != "a" || got[2].Name != "b" {
		t.Fatalf("wire-last order not preserved: %#v", got)
	}
}

// Ensure WireLast field is available on appmodule metadata (compile-time guard).
var _ = appmodule.ModuleMetadata{WireLast: true}

