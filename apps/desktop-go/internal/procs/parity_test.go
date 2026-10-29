package procs_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract/gen"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
)

func newRouter() *contract.Router {
	r := contract.NewRouter()
	core.New(core.LLMConfig{BaseURL: "http://127.0.0.1:1", APIKey: "x", Model: "m"}).Register(r)
	procs.Install(r)
	return r
}

// 契约里的每个过程都必须在 Go 端有注册，且 kind 对得上；Go 端不能多出契约外的过程。
func TestContractParity(t *testing.T) {
	raw, err := os.ReadFile("../contract/gen/contract.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var sch struct {
		Procedures map[string]struct {
			Kind string `json:"kind"`
		} `json:"procedures"`
	}
	if err := json.Unmarshal(raw, &sch); err != nil {
		t.Fatal(err)
	}
	if len(sch.Procedures) != len(gen.Procedures) {
		t.Fatalf("schema has %d procedures, table %d", len(sch.Procedures), len(gen.Procedures))
	}
	reg := newRouter().Registered()
	for name, p := range sch.Procedures {
		got, ok := reg[name]
		if !ok {
			t.Errorf("procedure %s has no Go handler", name)
			continue
		}
		want := "call"
		if p.Kind == "stream" {
			want = "stream"
		}
		if got != want {
			t.Errorf("procedure %s registered as %s, contract kind %s", name, got, p.Kind)
		}
	}
	for name := range reg {
		if _, ok := sch.Procedures[name]; !ok {
			t.Errorf("Go registers %s which is not in the contract", name)
		}
	}
	if len(sch.Procedures) != 359 {
		t.Logf("note: contract now has %d procedures", len(sch.Procedures))
	}
}

func session(t *testing.T, r *contract.Router, surface string) (*contract.Session, chan contract.ServerFrame) {
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: surface}, func(f contract.ServerFrame) { ch <- f })
	t.Cleanup(s.Close)
	return s, ch
}

func next(t *testing.T, ch chan contract.ServerFrame) contract.ServerFrame {
	select {
	case f := <-ch:
		return f
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for frame")
	}
	return contract.ServerFrame{}
}

func TestStubReturnsUnavailable(t *testing.T) {
	s, ch := session(t, newRouter(), "chat")
	s.Handle([]byte(`{"t":"req","id":"1","kind":"call","name":"theme.get"}`))
	f := next(t, ch)
	if f.T != "err" || f.Error.Code != "UNAVAILABLE" {
		t.Fatalf("got %+v", f)
	}
}

func TestStreamAbort(t *testing.T) {
	r := contract.NewRouter()
	started := make(chan struct{})
	r.Stream("x.s", func(ctx context.Context, _ contract.Caller, _ json.RawMessage, emit func(any) error) (any, error) {
		_ = emit(1)
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	})
	s, ch := session(t, r, "chat")
	s.Handle([]byte(`{"t":"req","id":"a","kind":"stream","name":"x.s"}`))
	if f := next(t, ch); f.T != "chunk" {
		t.Fatalf("want chunk, got %+v", f)
	}
	<-started
	s.Handle([]byte(`{"t":"abort","id":"a"}`))
	if f := next(t, ch); f.T != "err" || f.Error.Code != "ABORTED" {
		t.Fatalf("want ABORTED, got %+v", f)
	}
}

func TestEventsAndSurfaces(t *testing.T) {
	r := newRouter()
	s, ch := session(t, r, "mascot")
	s.Handle([]byte(`{"t":"sub","event":"theme.changed"}`))
	time.Sleep(10 * time.Millisecond)
	r.Emit("theme.changed", map[string]string{"pref": "dark"})
	r.Emit("other", 1)
	if f := next(t, ch); f.T != "event" || f.Event != "theme.changed" {
		t.Fatalf("got %+v", f)
	}
	for _, p := range gen.Procedures {
		if len(p.Surfaces) == 1 && p.Surfaces[0] == "chat" {
			k := "call"
			if p.Kind == "stream" {
				k = "stream"
			}
			s.Handle([]byte(`{"t":"req","id":"f","kind":"` + k + `","name":"` + p.Name + `"}`))
			if f := next(t, ch); f.T != "err" || f.Error.Code != "FORBIDDEN" {
				t.Fatalf("%s from mascot: %+v", p.Name, f)
			}
			return
		}
	}
}
