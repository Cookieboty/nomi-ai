package server

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
)

func TestRequestEffortPrefersTabBinding(t *testing.T) {
	tab := "high"
	b := &route.TabBinding{Effort: &tab}
	got := requestEffort(b, "low")
	if got == nil || *got != "high" {
		t.Fatalf("tab binding should win, got %v", got)
	}
	if requestEffort(nil, "  medium ") == nil || *requestEffort(nil, "  medium ") != "medium" {
		t.Fatal("header effort")
	}
	if requestEffort(nil, "  ") != nil {
		t.Fatal("blank header")
	}
	empty := "  "
	if requestEffort(&route.TabBinding{Effort: &empty}, "low") == nil || *requestEffort(&route.TabBinding{Effort: &empty}, "low") != "low" {
		t.Fatal("blank binding falls through to the header")
	}
}
