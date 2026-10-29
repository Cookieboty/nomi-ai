package contract

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// D-B11-12：Router.GateBefore —— 被门控的过程等屏障，未门控的直接过，abort（ctx 取消）结束等待
func TestRouterGateBefore(t *testing.T) {
	r := NewRouter()
	ok := func(context.Context, Caller, json.RawMessage) (any, error) { return "ok", nil }
	r.Call("gateway.get", ok)
	r.Call("mascot.get", ok)
	release := make(chan struct{})
	r.GateBefore([]string{"gateway."}, func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	var mu sync.Mutex
	frames := map[string]ServerFrame{}
	s := r.NewSession(context.Background(), Caller{}, func(f ServerFrame) { mu.Lock(); frames[f.ID] = f; mu.Unlock() })
	get := func(id string) (ServerFrame, bool) { mu.Lock(); defer mu.Unlock(); f, ok := frames[id]; return f, ok }
	wait := func(id string) ServerFrame {
		for i := 0; i < 200; i++ {
			if f, ok := get(id); ok {
				return f
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatalf("no reply for %s", id)
		return ServerFrame{}
	}
	call := func(id, name string) {
		s.Handle([]byte(`{"t":"req","id":"` + id + `","kind":"call","name":"` + name + `"}`))
	}

	call("1", "gateway.get")
	call("2", "mascot.get")
	if f := wait("2"); f.T != "res" {
		t.Fatalf("ungated call: %+v", f)
	}
	time.Sleep(30 * time.Millisecond)
	if _, done := get("1"); done {
		t.Fatal("gated call returned before the gate opened")
	}
	call("3", "gateway.get")
	s.Handle([]byte(`{"t":"abort","id":"3"}`))
	if f := wait("3"); f.T == "res" {
		t.Fatalf("aborted gated call should not succeed: %+v", f)
	}
	close(release)
	if f := wait("1"); f.T != "res" || f.Output != "ok" {
		t.Fatalf("gated call after release: %+v", f)
	}
}
