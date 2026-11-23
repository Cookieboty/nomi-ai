package conversationruntime

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestSessionClaudeCodexClaudeUsesRealRecoveryAndDelivery(t *testing.T) {
	claude, codex := newFakeRuntime("claude"), newFakeRuntime("codex")
	history := []Entry{{ID: "h1", TurnID: "h", Role: "user", Text: "old user"}, {ID: "h2", TurnID: "h", Role: "assistant", Text: "old answer"}}
	c := testSession(t, claude, history)
	first := sendFake(t, c, "u1")
	cc := claude.call(t, 0)
	if cc.request.Plan.Strategy != StrategyNewSession || len(cc.request.Plan.Selections) != 2 {
		t.Fatal("first runtime needs bounded full")
	}
	if bindings := c.Bindings(); len(bindings) != 1 || len(bindings[0].Coverage.Delivered) != 0 || bindings[0].NativeSessionID != "" {
		t.Fatal("recovery/submission falsely acknowledged delivery")
	}
	cc.complete(t, "claude reply", Activity{Known: true})
	originalNative := cc.request.NativeSessionID
	expectErrIs(t, c.Select(sessionTarget(codex, "codex")), nil)
	second := sendFake(t, c, "u2")
	xc := codex.call(t, 0)
	if xc.request.Plan.Strategy != StrategyNewSession || len(xc.request.Plan.Selections) != 4 {
		t.Fatal("new backend omitted product history")
	}
	xc.complete(t, "codex reply", Activity{Known: true})
	expectErrIs(t, c.Select(sessionTarget(claude, "claude")), nil)
	third := sendFake(t, c, "u3")
	back := claude.call(t, 1)
	if back.request.NativeSessionID != originalNative || c.State().Recovery.Kind != RecoveryResumed {
		t.Fatal("Claude did not resume original native binding")
	}
	ids := selectedIDs(back.request.Plan)
	if back.request.Plan.Strategy != StrategyDelta || len(ids) != 2 || ids[0] != "u2" || ids[1] != "reply_"+second.AttemptID {
		t.Fatalf("unseen delta = %v", ids)
	}
	for _, token := range []AttemptToken{first, second, third} {
		if token.ConversationID != "product_conv" {
			t.Fatal("product identity changed")
		}
	}
	snapshot := c.Messages()
	bindings := c.Bindings()
	state := c.State()
	for _, kind := range []EventKind{EventText, EventCompleted, EventDelivered, EventApproval, EventActivity} {
		late := cc.event(kind)
		late.Text = "LATE"
		late.ApprovalID = "late"
		late.Work = Activity{Known: true, Background: 99}
		expectErrIs(t, cc.emit(late), ErrStaleEvent)
	}
	if !reflect.DeepEqual(snapshot, c.Messages()) || !reflect.DeepEqual(bindings, c.Bindings()) || !reflect.DeepEqual(state, c.State()) {
		t.Fatal("old-generation event changed authoritative state")
	}
	back.complete(t, "claude follows up", Activity{Known: true})
	if len(c.Messages()) != 8 || len(c.Bindings()) != 2 {
		t.Fatal("transcript duplication or native binding lost")
	}
}

func TestSessionResumeFallbackActuallyReplansFull(t *testing.T) {
	f := newFakeRuntime("native")
	c := testSession(t, f, nil)
	sendFake(t, c, "u1")
	f.call(t, 0).complete(t, "reply", Activity{Known: true})
	old := c.Bindings()[0]
	f.setRecovery(func(_ context.Context, r RecoveryRequest) RecoveryResult {
		if r.Previous.NativeSessionID != old.NativeSessionID {
			t.Fatal("original resume target lost")
		}
		return RecoveryResult{Kind: RecoveryFallback, NativeSessionID: "fallback_native", Detail: "resume unavailable"}
	})
	sendFake(t, c, "u2")
	call := f.call(t, 1)
	if call.request.Plan.Strategy != StrategyNewSession || len(call.request.Plan.Selections) != 2 {
		t.Fatal("fallback reused old delta/coverage")
	}
	if c.State().Recovery.Kind != RecoveryFallback || len(c.Bindings()) != 2 {
		t.Fatal("fallback outcome/bindings hidden")
	}
	bad := call.event(EventDelivered)
	bad.Delivery = Delivery{PlanID: call.request.Plan.ID, Kind: DeliveredFull, NativeSessionID: old.NativeSessionID}
	expectErrIs(t, call.emit(bad), ErrReceipt)
	for _, b := range c.Bindings() {
		if b.ID != old.ID && len(b.Coverage.Delivered) != 0 {
			t.Fatal("wrong target advanced fresh coverage")
		}
	}
	call.complete(t, "new reply", Activity{Known: true})
	f.setRecovery(nil)
	sendFake(t, c, "u3")
	if f.call(t, 2).request.NativeSessionID != "fallback_native" || c.State().Recovery.Kind != RecoveryResumed {
		t.Fatal("confirmed fallback was not preferred over historical binding")
	}
}

func TestSessionUnknownAndErrorRecoveryAreDifferent(t *testing.T) {
	for _, kind := range []RecoveryKind{RecoveryUnknown, RecoveryError} {
		t.Run(string(kind), func(t *testing.T) {
			f := newFakeRuntime("r")
			f.setRecovery(func(context.Context, RecoveryRequest) RecoveryResult {
				return RecoveryResult{Kind: kind, Detail: "fake recovery"}
			})
			c := testSession(t, f, nil)
			request := Request{MessageID: "u", TurnID: "t", Text: "do work"}
			_, err := c.Start(context.Background(), request)
			if err == nil {
				t.Fatal("unsuccessful recovery started a turn")
			}
			_, starts, _ := f.counts()
			if starts != 0 {
				t.Fatal("user request submitted during recovery")
			}
			if kind == RecoveryUnknown {
				if c.State().Phase != PhaseUncertain {
					t.Fatal("unknown recovery not blocked")
				}
				if _, err = c.Start(context.Background(), Request{MessageID: "other", TurnID: "other", Text: "new"}); !errors.Is(err, ErrBusy) {
					t.Fatal("automatic retry after unknown")
				}
				if _, err = c.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
			} else if c.State().Phase != PhaseFailed {
				t.Fatal("proven recovery error should be pre-submit failure")
			}
			f.setRecovery(nil)
			if _, err = c.Start(context.Background(), request); !errors.Is(err, ErrAlreadyExecuted) {
				t.Fatal("silent retry without user intent")
			}
			request.Retry = true
			_, err = c.Start(context.Background(), request)
			expectErrIs(t, err, nil)
			f.call(t, 0).complete(t, "done", Activity{Known: true})
			if len(c.Messages()) != 2 {
				t.Fatal("retry duplicated user message")
			}
			if _, err = c.Start(context.Background(), request); !errors.Is(err, ErrAlreadyExecuted) {
				t.Fatal("completed side effect repeated")
			}
		})
	}
}

func TestSessionRejectsFalseResumedAndSilentNew(t *testing.T) {
	for _, kind := range []RecoveryKind{RecoveryResumed, RecoveryNew} {
		t.Run(string(kind), func(t *testing.T) {
			f := newFakeRuntime("r")
			c := testSession(t, f, nil)
			sendFake(t, c, "u1")
			f.call(t, 0).complete(t, "reply", Activity{Known: true})
			before := c.Bindings()
			f.setRecovery(func(context.Context, RecoveryRequest) RecoveryResult {
				return RecoveryResult{Kind: kind, NativeSessionID: "silently_different"}
			})
			_, err := c.Start(context.Background(), Request{MessageID: "u2", TurnID: "t2", Text: "next"})
			if !errors.Is(err, ErrProtocol) || c.State().Phase != PhaseUncertain {
				t.Fatal("silent new/false resumed was accepted")
			}
			_, starts, _ := f.counts()
			if starts != 1 || !reflect.DeepEqual(before, c.Bindings()) {
				t.Fatal("invalid recovery submitted or changed coverage")
			}
		})
	}
}

func TestSessionCompletionRequiresActualFullDelivery(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventText)
	e.Text = "unproven"
	expectErrIs(t, call.emit(e), ErrProtocol)
	e = call.event(EventCompleted)
	e.Work = Activity{Known: true}
	expectErrIs(t, call.emit(e), ErrProtocol)
	if c.State().Phase != PhaseUncertain || len(c.Messages()) != 1 {
		t.Fatal("unproven completion committed transcript")
	}
	expectErrIs(t, call.deliver(), ErrStaleEvent)
	for _, b := range c.Bindings() {
		if len(b.Coverage.Delivered) != 0 {
			t.Fatal("late ACK applied after failed completion")
		}
	}
}

func TestSessionPartialTargetDeliveryBlocksInsteadOfRetry(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, []Entry{{ID: "h", TurnID: "h", Role: "assistant", Text: "abcdef"}})
	sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventDelivered)
	e.Delivery = Delivery{PlanID: call.request.Plan.ID, NativeSessionID: call.request.NativeSessionID, Kind: DeliveredPartial, Parts: []DeliveredPart{{ID: "h", Rev: 1, Start: 0, End: 3}}}
	expectErrIs(t, call.emit(e), ErrUnknownState)
	b := c.Bindings()[0]
	if b.Status != StatusUnknown || len(b.Coverage.Delivered) != 0 || b.Coverage.Partial["h"].Ranges[0] != (ByteRange{0, 3}) {
		t.Fatal("partial receipt widened or erased")
	}
	if c.State().Phase != PhaseUncertain {
		t.Fatal("partial input could execute side effects; must block")
	}
	expectErrIs(t, call.deliver(), ErrStaleEvent)
}

func TestSessionCapabilitiesNeverPromoteUnsupportedPermissions(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	for _, mode := range []string{"autoapprove", "bypass", "unknown", ""} {
		target := sessionTarget(f, "claude")
		target.Env.PermissionMode = mode
		expectErrIs(t, c.Select(target), ErrPermission)
	}
	// Bypass still needs explicit confirmation even if advertised by an adapter.
	f.mu.Lock()
	f.caps.PermissionModes = append(f.caps.PermissionModes, "bypass")
	f.mu.Unlock()
	target := sessionTarget(f, "claude")
	target.Env.PermissionMode = "bypass"
	expectErrIs(t, c.Select(target), ErrPermission)
	target.ConfirmUnsafe = true
	expectErrIs(t, c.Select(target), nil)
	state := c.State()
	state.Capabilities.PermissionModes[0] = "mutated"
	state.Capabilities.Degraded[0] = "mutated"
	if c.State().Capabilities.PermissionModes[0] != "ask" || c.State().Capabilities.Degraded[0] == "mutated" {
		t.Fatal("capability snapshots alias mutable state")
	}
	r, s, a := f.counts()
	if r+s+a != 0 {
		t.Fatal("selection probes executed a runtime")
	}
}

func TestSessionNoResumeCapabilityUsesNewFullWithoutLosingBindings(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u1")
	f.call(t, 0).complete(t, "reply", Activity{Known: true})
	f.mu.Lock()
	f.caps.Resume = false
	f.mu.Unlock()
	expectErrIs(t, c.Select(sessionTarget(f, "claude")), nil)
	sendFake(t, c, "u2")
	f.mu.Lock()
	previous := f.recoveries[1].Previous
	f.mu.Unlock()
	if previous.ID != "" || f.call(t, 1).request.Plan.Strategy != StrategyNewSession || len(f.call(t, 1).request.Plan.Selections) != 2 || len(c.Bindings()) != 2 {
		t.Fatal("unsupported resume faked success or discarded old binding")
	}
}

func TestSessionCapabilitiesAcceptsAutoPermissionMode(t *testing.T) {
	f := newFakeRuntime("r")
	f.mu.Lock()
	f.caps.PermissionModes = append(f.caps.PermissionModes, "auto")
	f.mu.Unlock()
	c := testSession(t, f, nil)
	target := sessionTarget(f, "claude")
	target.Env.PermissionMode = "auto"
	expectErrIs(t, c.Select(target), nil)
	state := c.State()
	hasAuto := false
	for _, m := range state.Capabilities.PermissionModes {
		if m == "auto" {
			hasAuto = true
		}
	}
	if !hasAuto {
		t.Fatalf("expected auto in capabilities PermissionModes, got %+v", state.Capabilities.PermissionModes)
	}
	for _, d := range state.Capabilities.Degraded {
		if d == "unsupported product permission mode: auto" {
			t.Fatalf("auto permission mode should not degrade: %+v", state.Capabilities.Degraded)
		}
	}
}
