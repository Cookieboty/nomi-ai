package conversationruntime

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestSessionCancelUncertainFencesEverythingAndRequiresExplicitRetry(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	token := sendFake(t, c, "u")
	call := f.call(t, 0)
	expectErrIs(t, call.deliver(), nil)
	approval := call.event(EventApproval)
	approval.ApprovalID = "permit"
	expectErrIs(t, call.emit(approval), nil)
	f.setCancel(CancelResult{Kind: CancelUnknown, Detail: "unconfirmed stop"})
	_, err := c.Cancel(context.Background())
	expectErrIs(t, err, ErrUnknownState)
	before, bindings, state := c.Messages(), c.Bindings(), c.State()
	if state.Phase != PhaseUncertain || len(state.Approvals) != 0 {
		t.Fatal("cancel did not revoke approval ownership")
	}
	for _, kind := range []EventKind{EventText, EventDelivered, EventApproval, EventActivity, EventCompleted, EventFailed} {
		e := call.event(kind)
		e.Text = "late"
		e.ApprovalID = "late"
		e.Work = Activity{Known: true}
		expectErrIs(t, call.emit(e), ErrStaleEvent)
	}
	expectErrIs(t, c.Approve(context.Background(), token, "permit", true), ErrStaleEvent)
	if !reflect.DeepEqual(before, c.Messages()) || !reflect.DeepEqual(bindings, c.Bindings()) || !reflect.DeepEqual(state, c.State()) {
		t.Fatal("canceled generation mutated product state")
	}
	if _, err = c.Start(context.Background(), Request{MessageID: "other", TurnID: "other", Text: "again"}); !errors.Is(err, ErrBusy) {
		t.Fatal("uncertain stop allowed automatic execution")
	}
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("codex"), "codex")), ErrBusy)
	_, starts, decisions := f.counts()
	if starts != 1 || decisions != 0 {
		t.Fatal("stale approval/retry reached runtime")
	}
	f.setCancel(CancelResult{Kind: CancelStopped, Work: Activity{Known: true}})
	_, err = c.Cancel(context.Background())
	expectErrIs(t, err, nil)
	r := Request{MessageID: "u", TurnID: "turn_u", Text: "request u"}
	_, err = c.Start(context.Background(), r)
	expectErrIs(t, err, ErrAlreadyExecuted)
	r.Retry = true
	_, err = c.Start(context.Background(), r)
	expectErrIs(t, err, nil)
	if len(c.Messages()) != 1 {
		t.Fatal("explicit retry duplicated product request")
	}
	if f.call(t, 1).request.Plan.Strategy != StrategyNewSession {
		t.Fatal("uncertain native state was silently resumed")
	}
}

func TestSessionCancelDuringBlockedRecoveryCannotLateSubmit(t *testing.T) {
	f := newFakeRuntime("r")
	entered, release := make(chan struct{}), make(chan struct{})
	f.setRecovery(func(context.Context, RecoveryRequest) RecoveryResult {
		close(entered)
		<-release
		return RecoveryResult{Kind: RecoveryNew, NativeSessionID: "late_native"}
	})
	c := testSession(t, f, nil)
	done := make(chan error, 1)
	go func() {
		_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "run"})
		done <- err
	}()
	awaitTest(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := c.Cancel(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || c.State().Phase != PhaseUncertain {
		t.Fatal("blocked recovery cancellation falsely confirmed")
	}
	close(release)
	expectErrIs(t, awaitTest(t, done), ErrStaleEvent)
	_, starts, _ := f.counts()
	if starts != 0 {
		t.Fatal("late recovery submitted canceled request")
	}
	_, err = c.Cancel(context.Background())
	expectErrIs(t, err, nil)
}

func TestSessionCancelDuringBlockedStartRejectsLateSubmissionOutcome(t *testing.T) {
	f := newFakeRuntime("r")
	entered, release := make(chan struct{}), make(chan struct{})
	f.startFn = func(context.Context, RuntimeRequest, func(Event) error) SubmitResult {
		close(entered)
		<-release
		return SubmitResult{Kind: SubmitAccepted}
	}
	c := testSession(t, f, nil)
	done := make(chan error, 1)
	go func() {
		_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "run"})
		done <- err
	}()
	awaitTest(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := c.Cancel(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stop certainty = %v", err)
	}
	call := f.call(t, 0)
	expectErrIs(t, call.deliver(), ErrStaleEvent)
	close(release)
	expectErrIs(t, awaitTest(t, done), ErrStaleEvent)
	if c.State().Phase != PhaseUncertain || len(c.Bindings()[0].Coverage.Delivered) != 0 {
		t.Fatal("late Start return advanced target coverage")
	}
	_, err = c.Cancel(context.Background())
	expectErrIs(t, err, nil)
}

func TestSessionApprovalDecisionAndCancelShareOwnershipGate(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	token := sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventApproval)
	e.ApprovalID = "deny"
	expectErrIs(t, call.emit(e), nil)
	expectErrIs(t, c.Approve(context.Background(), token, "deny", false), nil)
	if len(c.State().Approvals) != 0 {
		t.Fatal("explicit denial not resolved")
	}
	f.mu.Lock()
	decision := f.decisions[0]
	f.mu.Unlock()
	if decision.Allow {
		t.Fatal("deny promoted to allow")
	}
	entered := make(chan struct{})
	f.mu.Lock()
	f.approveFn = func(ctx context.Context, _ ApprovalDecision) error { close(entered); <-ctx.Done(); return ctx.Err() }
	f.mu.Unlock()
	e.ApprovalID = "inflight"
	expectErrIs(t, call.emit(e), nil)
	done := make(chan error, 1)
	go func() { done <- c.Approve(context.Background(), token, "inflight", true) }()
	awaitTest(t, entered)
	_, err := c.Cancel(context.Background())
	expectErrIs(t, err, nil)
	expectErrIs(t, awaitTest(t, done), ErrStaleEvent)
	if len(c.State().Approvals) != 0 || c.State().Phase != PhaseCanceled {
		t.Fatal("late approval outcome revived old attempt")
	}
	expectErrIs(t, c.Approve(context.Background(), token, "inflight", true), ErrStaleEvent)
	_, _, decisions := f.counts()
	if decisions != 2 {
		t.Fatal("stale approval decision reached native runtime")
	}
}

func TestSessionSwitchNeedsProofOfTotalQuiescence(t *testing.T) {
	cases := []struct {
		name string
		work Activity
	}{
		{"background", Activity{Known: true, Background: 1}},
		{"subagent", Activity{Known: true, Subagents: 1}},
		{"native_queue", Activity{Known: true, Queued: 1}},
		{"native_approval", Activity{Known: true, PendingApprovals: 1}},
		{"still_running", Activity{Known: true, Running: true}},
		{"unknown", Activity{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeRuntime("r")
			c := testSession(t, f, nil)
			sendFake(t, c, "u")
			call := f.call(t, 0)
			expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), ErrBusy)
			call.complete(t, "answer", tc.work)
			expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), ErrBusy)
			e := call.event(EventActivity)
			e.Work = Activity{Known: true}
			expectErrIs(t, call.emit(e), nil)
			expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), nil)
			e.Work = Activity{Known: true, Background: 42}
			expectErrIs(t, call.emit(e), ErrStaleEvent)
			if !c.State().Work.Idle() {
				t.Fatal("old generation activity changed new runtime state")
			}
		})
	}
}

func TestSessionQueueIsFIFOExplicitAndBlocksSwitch(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	first := Request{MessageID: "one", TurnID: "one", Text: "first"}
	second := Request{MessageID: "two", TurnID: "two", Text: "second"}
	expectErrIs(t, c.Enqueue(first), nil)
	expectErrIs(t, c.Enqueue(first), ErrAlreadyExecuted)
	expectErrIs(t, c.Enqueue(second), nil)
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), ErrBusy)
	_, err := c.Start(context.Background(), Request{MessageID: "skip", TurnID: "skip", Text: "skip queue"})
	expectErrIs(t, err, ErrBusy)
	_, starts, _ := f.counts()
	if starts != 0 {
		t.Fatal("queue automatically executed")
	}
	_, err = c.StartNext(context.Background())
	expectErrIs(t, err, nil)
	if f.call(t, 0).request.Plan.RequestBody != "first" || c.State().Queued != 1 {
		t.Fatal("queue was not FIFO")
	}
	f.call(t, 0).complete(t, "first done", Activity{Known: true})
	_, starts, _ = f.counts()
	if starts != 1 {
		t.Fatal("completed turn auto-ran queued work")
	}
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), ErrBusy)
	expectErrIs(t, c.DropQueued("two"), nil)
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), nil)
}

func TestSessionUnsupportedApprovalAndCancelNeverAutoAllow(t *testing.T) {
	f := newFakeRuntime("r")
	f.caps.Approval = false
	f.caps.Cancel = false
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventApproval)
	e.ApprovalID = "unsupported"
	expectErrIs(t, call.emit(e), ErrPermission)
	_, err := c.Cancel(context.Background())
	expectErrIs(t, err, ErrUnknownState)
	if c.State().Phase != PhaseUncertain {
		t.Fatal("unsupported stop falsely confirmed")
	}
	_, _, decisions := f.counts()
	if decisions != 0 {
		t.Fatal("unsupported approval was automatically allowed")
	}
}

func TestSessionContextCancellationFencesStreamAndBackground(t *testing.T) {
	for _, completed := range []bool{false, true} {
		f := newFakeRuntime("r")
		c := testSession(t, f, nil)
		ctx, cancel := context.WithCancel(context.Background())
		_, err := c.Start(ctx, Request{MessageID: "u", TurnID: "t", Text: "run"})
		expectErrIs(t, err, nil)
		call := f.call(t, 0)
		if completed {
			call.complete(t, "answer", Activity{Known: true, Background: 1})
		}
		before := c.Messages()
		cancel()
		if c.State().Phase != PhaseUncertain {
			t.Fatal("canceled context left active generation sendable")
		}
		e := call.event(EventText)
		e.Text = "late"
		expectErrIs(t, call.emit(e), ErrStaleEvent)
		if !reflect.DeepEqual(before, c.Messages()) {
			t.Fatal("context-canceled event appended transcript")
		}
	}
}

func TestSessionNoBudgetNoProbeAndNoTranscriptWrite(t *testing.T) {
	f := newFakeRuntime("r")
	f.caps.Budget = 2
	c := testSession(t, f, nil)
	_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "too large"})
	var budget *ErrBudget
	if !errors.As(err, &budget) {
		t.Fatalf("expected exact request refusal, got %v", err)
	}
	r, s, _ := f.counts()
	if r+s != 0 || len(c.Messages()) != 0 {
		t.Fatal("over-budget request mutated or launched runtime")
	}
}
