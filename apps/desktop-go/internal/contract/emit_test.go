package contract

import (
	"context"
	"testing"
)

func TestEmitToSurface(t *testing.T) {
	r := NewRouter()
	got := map[string]int{}
	for _, sf := range []string{"chat", "mascot"} {
		sf := sf
		s := r.NewSession(context.Background(), Caller{Surface: sf}, func(f ServerFrame) { got[sf]++ })
		s.Handle([]byte(`{"t":"sub","event":"desktop.summary"}`))
	}
	if !r.EmitTo("desktop.summary", 1, "chat") || got["chat"] != 1 || got["mascot"] != 0 {
		t.Fatalf("%v", got)
	}
	if r.EmitTo("desktop.summary", 1, "settings") {
		t.Fatal("no settings subscriber")
	}
	r.Emit("desktop.summary", 1)
	if got["chat"] != 2 || got["mascot"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestEmitToCaller(t *testing.T) {
	r := NewRouter()
	got := map[int]int{}
	s1 := r.NewSession(context.Background(), Caller{Surface: "chat", ID: 101}, func(ServerFrame) { got[101]++ })
	s2 := r.NewSession(context.Background(), Caller{Surface: "chat", ID: 102}, func(ServerFrame) { got[102]++ })
	s1.Handle([]byte(`{"t":"sub","event":"chatWindow.dockRequest"}`))
	s2.Handle([]byte(`{"t":"sub","event":"chatWindow.dockRequest"}`))

	if r.EmitToCaller(0, "chatWindow.dockRequest", map[string]string{"id": "x"}) {
		t.Fatal("callerID <= 0 should not emit")
	}
	if r.EmitToCaller(999, "chatWindow.dockRequest", map[string]string{"id": "x"}) {
		t.Fatal("unknown callerID should return false")
	}
	if !r.EmitToCaller(101, "chatWindow.dockRequest", map[string]string{"id": "x"}) {
		t.Fatal("expected delivery to caller 101")
	}
	if got[101] != 1 || got[102] != 0 {
		t.Fatalf("unexpected delivery counts: %+v", got)
	}
}
