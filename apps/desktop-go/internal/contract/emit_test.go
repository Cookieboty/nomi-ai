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
