package wailsshell

import (
	"strings"
	"testing"
)

func TestDetachedURL(t *testing.T) {
	got := detachedURL("/chat/index.html", "detached=%7B%7D", "ws=x&token=y")
	if got != "/chat/index.html?detached=%7B%7D#ws=x&token=y" {
		t.Fatal(got)
	}
	if got := detachedURL("/chat/index.html", "", ""); got != "/chat/index.html" {
		t.Fatal(got)
	}
}

func TestDetachedName(t *testing.T) {
	a, b := detachedName(`["nomi:c1","harness:t1"]`), detachedName(`["nomi:c1","harness:t2"]`)
	if a == b || !strings.HasPrefix(a, "detached-") || len(a) != len("detached-")+12 {
		t.Fatalf("%q %q", a, b)
	}
	if detachedName("x") != detachedName("x") {
		t.Fatal("stable")
	}
}
