package mainchat

import (
	"context"
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

func (s stubRuntime) Capabilities() cr.Capabilities {
	return cr.Capabilities{PermissionModes: []string{"ask"}, Budget: 4096}
}

type stubRuntime struct{}

func (stubRuntime) Recover(context.Context, cr.RecoveryRequest) cr.RecoveryResult {
	return cr.RecoveryResult{}
}
func (stubRuntime) Start(context.Context, cr.RuntimeRequest, func(cr.Event) error) cr.SubmitResult {
	return cr.SubmitResult{}
}
func (stubRuntime) Cancel(context.Context, cr.AttemptToken) cr.CancelResult { return cr.CancelResult{} }
func (stubRuntime) Approve(context.Context, cr.ApprovalDecision) error      { return nil }

func TestSwitchEffortDefaultResetsConfig(t *testing.T) {
	if !convstore.ManagedSupported() {
		t.Skip("managed durability gate")
	}
	s := convstore.New(t.TempDir())
	if _, err := s.Put(json.RawMessage(`{"id":"c-effort","backend":"nomi"}`), nil, nil); err != nil {
		t.Fatal(err)
	}
	r := New(s, nil)
	r.Register("claude", func(string) (cr.Target, error) {
		return cr.Target{
			Runtime:  stubRuntime{},
			Identity: cr.NativeIdentity{DriverID: "claude", Transport: "fake", DriverVersion: "1", ResumeProtocol: "none", Executable: "claude", Source: "local", ConfigDir: "/tmp/cfg", Cwd: "/tmp/ws", ConfigGen: 1},
			Env:      cr.CompatibilityKey{PermissionMode: "ask"},
		}, nil
	})
	if err := r.Adopt("c-effort", "claude", true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Switch(context.Background(), "c-effort", SwitchOptions{
		Backend: "claude",
		Effort:  "high",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if got := r.ConfigFor("c-effort", "claude").Effort; got != "high" {
		t.Fatalf("expected effort high, got %q", got)
	}
	if _, err := r.Switch(context.Background(), "c-effort", SwitchOptions{
		Backend: "claude",
		Effort:  "default",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if got := r.ConfigFor("c-effort", "claude").Effort; got != "" {
		t.Fatalf("expected effort reset to empty, got %q", got)
	}
	st, err := r.State("c-effort")
	if err != nil {
		t.Fatal(err)
	}
	if st.Effort != "" {
		t.Fatalf("expected state effort empty after reset, got %q", st.Effort)
	}
}

type modeStubRuntime struct {
	modes []string
}

func (m modeStubRuntime) Capabilities() cr.Capabilities {
	return cr.Capabilities{PermissionModes: m.modes, Budget: 4096}
}
func (modeStubRuntime) Recover(context.Context, cr.RecoveryRequest) cr.RecoveryResult {
	return cr.RecoveryResult{}
}
func (modeStubRuntime) Start(context.Context, cr.RuntimeRequest, func(cr.Event) error) cr.SubmitResult {
	return cr.SubmitResult{}
}
func (modeStubRuntime) Cancel(context.Context, cr.AttemptToken) cr.CancelResult {
	return cr.CancelResult{}
}
func (modeStubRuntime) Approve(context.Context, cr.ApprovalDecision) error { return nil }

func TestCrossBackendSwitchResetsStalePermissionMode(t *testing.T) {
	if !convstore.ManagedSupported() {
		t.Skip("managed durability gate")
	}
	s := convstore.New(t.TempDir())
	if _, err := s.Put(json.RawMessage(`{"id":"c-switch-perm","backend":"nomi"}`), nil, nil); err != nil {
		t.Fatal(err)
	}
	r := New(s, nil)
	defer r.Close()

	registerModeStub := func(name, defMode string, modes []string) {
		r.Register(name, func(id string) (cr.Target, error) {
			cfg := r.ConfigFor(id, name)
			perm := cfg.PermissionMode
			if perm == "" {
				perm = defMode
			}
			return cr.Target{
				Runtime:  &modeStubRuntime{modes: modes},
				Identity: cr.NativeIdentity{DriverID: name, Transport: "fake", DriverVersion: "1", ResumeProtocol: "none", Executable: name, Source: "local", ConfigDir: "/tmp/cfg-" + name, Cwd: "/tmp/ws", ConfigGen: 1},
				Env:      cr.CompatibilityKey{Model: cfg.Model, PermissionMode: perm},
			}, nil
		})
	}
	registerModeStub("grok", "auto", []string{"deny", "ask", "acceptEdits", "auto", "bypass"})
	registerModeStub("gemini", "acceptEdits", []string{"deny", "ask", "acceptEdits", "bypass"})

	// 1. Adopt grok starts with default "auto", then explicitly set "ask".
	if err := r.Adopt("c-switch-perm", "grok", true); err != nil {
		t.Fatal(err)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "auto" {
		t.Fatalf("adopt grok initial PermissionMode = %q (%v), want auto", st.PermissionMode, err)
	}
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend:        "grok",
		PermissionMode: "ask",
		Confirm:        true,
	}); err != nil {
		t.Fatal(err)
	}

	// 2. Same-backend update keeps user-selected "ask".
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend: "grok",
		Model:   "grok-custom",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "ask" || st.Model != "grok-custom" {
		t.Fatalf("same-backend switch lost PermissionMode: mode=%q model=%q err=%v", st.PermissionMode, st.Model, err)
	}

	// 3. Switch to gemini (auto-priority -> "acceptEdits"), then explicitly set gemini to "ask".
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend: "gemini",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "acceptEdits" {
		t.Fatalf("switch to gemini initial PermissionMode = %q (%v), want acceptEdits", st.PermissionMode, err)
	}
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend:        "gemini",
		PermissionMode: "ask",
		Confirm:        true,
	}); err != nil {
		t.Fatal(err)
	}

	// 4. Cross-backend switch back to grok without explicit PermissionMode clears stale "ask" -> "auto", keeping model.
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend: "grok",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if got := r.ConfigFor("c-switch-perm", "grok").PermissionMode; got != "" {
		t.Fatalf("expected cleared PermissionMode in config for grok, got %q", got)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "auto" || st.Model != "grok-custom" {
		t.Fatalf("switch back to grok = mode:%q model:%q err:%v, want auto + grok-custom", st.PermissionMode, st.Model, err)
	}

	// 5. Cross-backend switch back to gemini clears stale "ask" -> "acceptEdits".
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend: "gemini",
		Confirm: true,
	}); err != nil {
		t.Fatal(err)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "acceptEdits" {
		t.Fatalf("switch back to gemini = %q (%v), want acceptEdits", st.PermissionMode, err)
	}

	// 6. Release and re-adopt grok without explicit PermissionMode starts fresh with "auto".
	if _, err := r.Switch(context.Background(), "c-switch-perm", SwitchOptions{
		Backend:        "grok",
		PermissionMode: "ask",
		Confirm:        true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.Release("c-switch-perm"); err != nil {
		t.Fatal(err)
	}
	if err := r.Adopt("c-switch-perm", "grok", true); err != nil {
		t.Fatal(err)
	}
	if st, err := r.State("c-switch-perm"); err != nil || st.PermissionMode != "auto" {
		t.Fatalf("re-adopt grok PermissionMode = %q (%v), want auto", st.PermissionMode, err)
	}
}
