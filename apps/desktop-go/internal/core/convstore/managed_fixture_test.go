package convstore

import (
	"context"
	"runtime"
	"sync"
	"testing"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

type diskFakeRuntime struct {
	mu        sync.Mutex
	calls     []cr.RuntimeRequest
	next      int
	approvals int
	cancels   int
	fallback  bool
}

func (f *diskFakeRuntime) Capabilities() cr.Capabilities {
	return cr.Capabilities{Resume: true, Cancel: true, Approval: true, PermissionModes: []string{"ask"}, Budget: 8192, Wrapper: cr.HandoffWrapper{Prefix: "<history>", Suffix: "</history>"}}
}
func (f *diskFakeRuntime) Recover(_ context.Context, r cr.RecoveryRequest) cr.RecoveryResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	if r.Previous.ID != "" && f.fallback {
		return cr.RecoveryResult{Kind: cr.RecoveryFallback, NativeSessionID: "fallback-native"}
	}
	if r.Previous.ID != "" {
		return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: r.Previous.NativeSessionID}
	}
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: "disk_native_" + string(rune('a'+f.next))}
}
func (f *diskFakeRuntime) Start(_ context.Context, r cr.RuntimeRequest, _ func(cr.Event) error) cr.SubmitResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r)
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}
func (f *diskFakeRuntime) Cancel(context.Context, cr.AttemptToken) cr.CancelResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels++
	return cr.CancelResult{Kind: cr.CancelStopped, Work: cr.Activity{Known: true}}
}
func (f *diskFakeRuntime) Approve(context.Context, cr.ApprovalDecision) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approvals++
	return nil
}
func (f *diskFakeRuntime) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }
func (f *diskFakeRuntime) call(t *testing.T, index int) cr.RuntimeRequest {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if index >= len(f.calls) {
		t.Fatalf("missing disk fake call %d", index)
	}
	return f.calls[index]
}
func diskTarget(f *diskFakeRuntime) cr.Target {
	return cr.Target{Runtime: f, Identity: cr.NativeIdentity{DriverID: "fake", Transport: "fake-stdin", DriverVersion: "1", ResumeProtocol: "fake-resume", Executable: "/fake/cli", Source: "local", AccountID: "fake-account", ConfigDir: "/fake/config", Cwd: "/fake/project", ConfigGen: 1}, Env: cr.CompatibilityKey{Model: "fake-model", PermissionMode: "ask"}}
}
func diskFixture(t *testing.T) (string, *Store, *ManagedLease, *cr.Session, *diskFakeRuntime) {
	t.Helper()
	requireManagedDurability(t)
	dir := t.TempDir()
	s := New(dir)
	mustPut(t, s, `{"id":"c","name":"API history","extra":{"unknown":9007199254740993}}`, msgs(`{"id":"old","role":"user","content":"old user","custom":{"keep":true}}`))
	if _, err := s.AdoptManaged("c"); err != nil {
		t.Fatal(err)
	}
	lease, err := s.OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Close() })
	session, err := lease.Session()
	if err != nil {
		t.Fatal(err)
	}
	f := &diskFakeRuntime{}
	if err = session.Select(diskTarget(f)); err != nil {
		t.Fatal(err)
	}
	return dir, s, lease, session, f
}
func startDisk(t *testing.T, c *cr.Session) cr.AttemptToken {
	t.Helper()
	token, err := c.Start(context.Background(), cr.Request{MessageID: "new", TurnID: "turn-new", Text: "new request"})
	if err != nil {
		t.Fatal(err)
	}
	return token
}
func diskEvent(r cr.RuntimeRequest, kind cr.EventKind) cr.Event {
	return cr.Event{Token: r.Token, NativeSessionID: r.NativeSessionID, Kind: kind}
}
func ackDisk(t *testing.T, c *cr.Session, r cr.RuntimeRequest) {
	t.Helper()
	e := diskEvent(r, cr.EventDelivered)
	e.Delivery = cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}
	if err := c.AcceptRuntimeEvent(e); err != nil {
		t.Fatal(err)
	}
}
func completeDisk(t *testing.T, c *cr.Session, r cr.RuntimeRequest) {
	t.Helper()
	ackDisk(t, c, r)
	e := diskEvent(r, cr.EventText)
	e.Text = "final answer"
	if err := c.AcceptRuntimeEvent(e); err != nil {
		t.Fatal(err)
	}
	e = diskEvent(r, cr.EventCompleted)
	e.Work = cr.Activity{Known: true}
	if err := c.AcceptRuntimeEvent(e); err != nil {
		t.Fatal(err)
	}
}

// These success-path fixtures require the implemented Unix fsync primitive.
// Windows has a separate executable fail-closed assertion, not fake durability.
func requireManagedDurability(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("v2 directory durability unsupported on Windows; platform gate is tested separately")
	}
}
