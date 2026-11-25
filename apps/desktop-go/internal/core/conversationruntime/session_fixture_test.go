package conversationruntime

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeCall struct {
	request RuntimeRequest
	emit    func(Event) error
}
type fakeRuntime struct {
	mu           sync.Mutex
	caps         Capabilities
	prefix       string
	next         int
	recoveries   []RecoveryRequest
	calls        []fakeCall
	decisions    []ApprovalDecision
	cancels      int
	recoverFn    func(context.Context, RecoveryRequest) RecoveryResult
	startFn      func(context.Context, RuntimeRequest, func(Event) error) SubmitResult
	approveFn    func(context.Context, ApprovalDecision) error
	cancelResult CancelResult
}

func newFakeRuntime(prefix string) *fakeRuntime {
	return &fakeRuntime{prefix: prefix, caps: Capabilities{Resume: true, Cancel: true, Approval: true, PermissionModes: []string{"ask", "deny"}, Budget: 8192, Wrapper: wrapper(), Degraded: []string{"no shared memory/MCP/skills"}}, cancelResult: CancelResult{Kind: CancelStopped, Work: Activity{Known: true}}}
}
func (f *fakeRuntime) Capabilities() Capabilities {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.caps.clone()
}
func (f *fakeRuntime) Recover(ctx context.Context, r RecoveryRequest) RecoveryResult {
	f.mu.Lock()
	f.recoveries = append(f.recoveries, r)
	fn := f.recoverFn
	f.next++
	id := f.prefix + "_native_" + itoa(f.next)
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, r)
	}
	if r.Previous.ID != "" {
		return RecoveryResult{Kind: RecoveryResumed, NativeSessionID: r.Previous.NativeSessionID}
	}
	return RecoveryResult{Kind: RecoveryNew, NativeSessionID: id}
}
func (f *fakeRuntime) Start(ctx context.Context, r RuntimeRequest, emit func(Event) error) SubmitResult {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{request: r, emit: emit})
	fn := f.startFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, r, emit)
	}
	return SubmitResult{Kind: SubmitAccepted}
}
func (f *fakeRuntime) Cancel(ctx context.Context, _ AttemptToken) CancelResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancels++
	return f.cancelResult
}
func (f *fakeRuntime) Approve(ctx context.Context, d ApprovalDecision) error {
	f.mu.Lock()
	f.decisions = append(f.decisions, d)
	fn := f.approveFn
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, d)
	}
	return nil
}
func (f *fakeRuntime) call(t *testing.T, i int) fakeCall {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.calls) {
		t.Fatalf("missing fake call %d (have %d)", i, len(f.calls))
	}
	call := f.calls[i]
	call.request.Plan = clonePlan(call.request.Plan)
	return call
}
func (f *fakeRuntime) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.recoveries), len(f.calls), len(f.decisions)
}
func (f *fakeRuntime) setCancel(r CancelResult) { f.mu.Lock(); defer f.mu.Unlock(); f.cancelResult = r }
func (f *fakeRuntime) setRecovery(fn func(context.Context, RecoveryRequest) RecoveryResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recoverFn = fn
}
func (call fakeCall) event(kind EventKind) Event {
	return Event{Token: call.request.Token, NativeSessionID: call.request.NativeSessionID, Kind: kind}
}
func (call fakeCall) deliver() error {
	e := call.event(EventDelivered)
	e.Delivery = Delivery{PlanID: call.request.Plan.ID, Kind: DeliveredFull, NativeSessionID: call.request.NativeSessionID}
	return call.emit(e)
}
func (call fakeCall) complete(t *testing.T, text string, work Activity) {
	t.Helper()
	expectErrIs(t, call.deliver(), nil)
	e := call.event(EventText)
	e.Text = text
	expectErrIs(t, call.emit(e), nil)
	e = call.event(EventCompleted)
	e.Work = work
	expectErrIs(t, call.emit(e), nil)
}
func sessionTarget(f *fakeRuntime, driver string) Target {
	id := fakeIdent()
	id.DriverID = driver
	id.Executable = "/fake/" + driver
	return Target{Runtime: f, Identity: id, Env: fakeEnv()}
}
func testSession(t *testing.T, f *fakeRuntime, history []Entry) *Session {
	t.Helper()
	c, err := NewSession("product_conv", history)
	expectErrIs(t, err, nil)
	expectErrIs(t, c.Select(sessionTarget(f, "claude")), nil)
	return c
}
func sendFake(t *testing.T, c *Session, id string) AttemptToken {
	t.Helper()
	token, err := c.Start(context.Background(), Request{MessageID: id, TurnID: "turn_" + id, Text: "request " + id})
	expectErrIs(t, err, nil)
	return token
}
func awaitTest[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("fake operation stalled")
		var zero T
		return zero
	}
}
