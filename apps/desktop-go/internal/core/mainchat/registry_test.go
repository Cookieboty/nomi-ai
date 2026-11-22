package mainchat

import (
	"encoding/json"
	"errors"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"sync/atomic"
	"testing"
	"time"
)

func TestOwnedReleaseOutsideLocksFencesReopenAndCloseWaits(t *testing.T) {
	if !convstore.ManagedSupported() {
		t.Skip("managed durability gate")
	}
	s := convstore.New(t.TempDir())
	if _, err := s.Put(json.RawMessage(`{"id":"c","backend":"nomi"}`), nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AdoptManaged("c"); err != nil {
		t.Fatal(err)
	}
	r := New(s, nil)
	if _, err := r.get("c"); err != nil {
		t.Fatal(err)
	}
	entered, gate := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	r.RegisterOwned("owned", func(string) (cr.Target, error) { return cr.Target{}, nil }, func(id string) {
		calls.Add(1)
		if _, err := r.State(id); !errors.Is(err, ErrUnavailable) {
			t.Error("reentrant state reopened released actor", err)
		}
		close(entered)
		<-gate
	})
	released := make(chan struct{})
	go func() { _ = r.Release("c"); close(released) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("release callback deadlocked")
	}
	closed := make(chan struct{})
	go func() { r.Close(); close(closed) }()
	select {
	case <-closed:
		t.Error("shutdown did not wait for in-flight native release")
	case <-time.After(10 * time.Millisecond):
	}
	close(gate)
	for _, done := range []chan struct{}{released, closed} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("shutdown/release deadlock")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("native owner released multiple times", calls.Load())
	}
}
