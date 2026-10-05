package thonnascache

import (
	"context"
	"testing"
)

func TestNoOpCacheProvider_SetOps(t *testing.T) {
	ctx := context.Background()
	c := NewNoOpCacheProvider()

	if err := c.SetAdd(ctx, "presence", "user-a"); err != nil {
		t.Fatalf("SetAdd: %v", err)
	}
	if err := c.SetAdd(ctx, "presence", "user-b"); err != nil {
		t.Fatalf("SetAdd: %v", err)
	}

	n, err := c.SetCardinality(ctx, "presence")
	if err != nil {
		t.Fatalf("SetCardinality: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 members, got %d", n)
	}

	if err := c.SetRemove(ctx, "presence", "user-a"); err != nil {
		t.Fatalf("SetRemove: %v", err)
	}
	n, err = c.SetCardinality(ctx, "presence")
	if err != nil {
		t.Fatalf("SetCardinality: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 member, got %d", n)
	}
}

