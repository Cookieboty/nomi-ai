package conversationruntime

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
)

func TestSessionSameNativeIDAcrossDriversIsNamespaced(t *testing.T) {
	cdriver, xdriver := newFakeRuntime("same"), newFakeRuntime("same")
	c := testSession(t, cdriver, nil)
	sendFake(t, c, "u1")
	cdriver.call(t, 0).complete(t, "answer", Activity{Known: true})
	expectErrIs(t, c.Select(sessionTarget(xdriver, "codex")), nil)
	sendFake(t, c, "u2")
	xc := xdriver.call(t, 0)
	if xc.request.NativeSessionID != cdriver.call(t, 0).request.NativeSessionID {
		t.Fatal("fixture must collide native IDs")
	}
	if xc.request.Plan.Strategy != StrategyNewSession {
		t.Fatal("different driver namespace treated as resume")
	}
	xc.complete(t, "answer two", Activity{Known: true})
	expectErrIs(t, c.Select(sessionTarget(cdriver, "claude")), nil)
	sendFake(t, c, "u3")
	if c.State().Recovery.Kind != RecoveryResumed || len(c.Bindings()) != 2 {
		t.Fatal("namespaced native bindings not preserved")
	}
}

func TestSessionCompatibilityChangeNeverResumesWrongBinding(t *testing.T) {
	mutations := map[string]func(*Target){
		"model":      func(x *Target) { x.Env.Model = "other" },
		"effort":     func(x *Target) { x.Env.Effort = "high" },
		"permission": func(x *Target) { x.Env.PermissionMode = "deny" },
		"source":     func(x *Target) { x.Identity.Source = "official" },
		"account":    func(x *Target) { x.Identity.AccountID = "other-account" },
		"cwd":        func(x *Target) { x.Identity.Cwd = "/another/workspace" },
		"config":     func(x *Target) { x.Identity.ConfigGen++ },
	}
	for name, mut := range mutations {
		t.Run(name, func(t *testing.T) {
			f := newFakeRuntime("r")
			c := testSession(t, f, nil)
			sendFake(t, c, "u1")
			f.call(t, 0).complete(t, "answer", Activity{Known: true})
			old := c.Bindings()[0]
			target := sessionTarget(f, "claude")
			mut(&target)
			expectErrIs(t, c.Select(target), nil)
			sendFake(t, c, "u2")
			f.mu.Lock()
			previous := f.recoveries[1].Previous
			f.mu.Unlock()
			if previous.ID != "" || f.call(t, 1).request.Plan.Strategy != StrategyNewSession {
				t.Fatal("incompatible native binding resumed")
			}
			found := false
			for _, b := range c.Bindings() {
				if b.ID == old.ID {
					found = reflect.DeepEqual(b, old)
				}
			}
			if !found {
				t.Fatal("compatibility change clobbered old native binding")
			}
		})
	}
}

func TestSessionWrongReceiptCannotClearApprovalsOrMarkUnknown(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventApproval)
	e.ApprovalID = "pending"
	expectErrIs(t, call.emit(e), nil)
	state, bindings := c.State(), c.Bindings()
	for _, kind := range []DeliveryKind{DeliveredFull, DeliveredUnknown, DeliveredPreSubmitFailed} {
		e = call.event(EventDelivered)
		e.Delivery = Delivery{PlanID: call.request.Plan.ID, Kind: kind, NativeSessionID: "other-native"}
		expectErrIs(t, call.emit(e), ErrReceipt)
	}
	if !reflect.DeepEqual(state, c.State()) || !reflect.DeepEqual(bindings, c.Bindings()) {
		t.Fatal("wrong delivery target mutated approval/coverage/state")
	}
}

func TestSessionReplyIDCollisionDoesNotDestroyConversation(t *testing.T) {
	f := newFakeRuntime("r")
	// Select consumes generation 1, first attempt generation 2: do not collide
	// with a legacy/user-chosen message ID that resembles an internal reply ID.
	c := testSession(t, f, []Entry{{ID: "reply_a2", Role: "assistant", TurnID: "old", Text: "keep me"}})
	sendFake(t, c, "u")
	f.call(t, 0).complete(t, "new reply", Activity{Known: true})
	messages := c.Messages()
	if len(messages) != 3 || messages[0].Text != "keep me" || messages[2].Text != "new reply" || messages[0].ID == messages[2].ID {
		t.Fatal("generated reply ID overwrote or rejected valid history")
	}
}

func TestSessionSeedCannotSilentlyDowngradeRevision(t *testing.T) {
	_, err := NewSession("product", []Entry{{ID: "edited", Revision: 2, Order: 1, Role: "user", Text: "edited"}})
	if err == nil {
		t.Fatal("revised durable history silently reset to revision 1")
	}
}

func TestSessionSubmittedIsNotDeliveredAndPreSubmitFailureIsExplicit(t *testing.T) {
	for _, kind := range []SubmitKind{SubmitUnknown, SubmitNotSent} {
		t.Run(string(kind), func(t *testing.T) {
			f := newFakeRuntime("r")
			f.startFn = func(context.Context, RuntimeRequest, func(Event) error) SubmitResult { return SubmitResult{Kind: kind} }
			c := testSession(t, f, nil)
			_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "execute"})
			if err == nil {
				t.Fatal("unsuccessful submission reported success")
			}
			if len(c.Bindings()[0].Coverage.Delivered) != 0 {
				t.Fatal("submission return value falsely ACKed delivery")
			}
			if kind == SubmitUnknown && c.State().Phase != PhaseUncertain {
				t.Fatal("unknown submission permits replay")
			}
			if kind == SubmitNotSent && c.State().Phase != PhaseFailed {
				t.Fatal("proven not-sent failure not distinguished")
			}
		})
	}
}

func TestSessionCancelStoppedStillNeedsBackgroundProof(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	f.setCancel(CancelResult{Kind: CancelStopped, Work: Activity{Known: true, Background: 1}})
	_, err := c.Cancel(context.Background())
	expectErrIs(t, err, ErrUnknownState)
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), ErrBusy)
	f.setCancel(CancelResult{Kind: CancelStopped, Work: Activity{Known: true}})
	_, err = c.Cancel(context.Background())
	expectErrIs(t, err, nil)
	expectErrIs(t, c.Select(sessionTarget(newFakeRuntime("x"), "codex")), nil)
}

func TestSessionAttachmentsAreExplicitlyRefusedAndNotDropped(t *testing.T) {
	f := newFakeRuntime("r")
	f.caps.Attachments = true
	c := testSession(t, f, nil)
	if c.State().Capabilities.Attachments {
		t.Fatal("native capability falsely advertised an unwired product bridge")
	}
	_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "see image", Attachments: []string{"asset:fake"}})
	if !errors.Is(err, ErrBadEdit) {
		t.Fatal("product attachment silently discarded")
	}
	recoveries, starts, _ := f.counts()
	if recoveries+starts != 0 || len(c.Messages()) != 0 {
		t.Fatal("unsupported input reached runtime")
	}
}

func TestSessionForeignConversationTokenCannotMutateAnything(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	call := f.call(t, 0)
	before, bindings, state := c.Messages(), c.Bindings(), c.State()
	for _, kind := range []EventKind{EventText, EventDelivered, EventApproval, EventCompleted, EventActivity} {
		e := call.event(kind)
		e.Token.ConversationID = "another-product-conversation"
		e.Text = "foreign"
		e.ApprovalID = "foreign"
		expectErrIs(t, call.emit(e), ErrStaleEvent)
	}
	if !reflect.DeepEqual(before, c.Messages()) || !reflect.DeepEqual(bindings, c.Bindings()) || !reflect.DeepEqual(state, c.State()) {
		t.Fatal("cross-conversation event changed state")
	}
}

func TestSessionNativeUnsafeFlagCannotInventProductPermission(t *testing.T) {
	f := newFakeRuntime("r")
	f.caps.PermissionModes = append(f.caps.PermissionModes, "autoapprove")
	c := testSession(t, f, nil)
	target := sessionTarget(f, "claude")
	target.Env.PermissionMode = "autoapprove"
	target.ConfirmUnsafe = true
	expectErrIs(t, c.Select(target), ErrPermission)
	for _, mode := range c.State().Capabilities.PermissionModes {
		if mode == "autoapprove" {
			t.Fatal("unmapped native mode advertised as product permission")
		}
	}
}

func TestSessionRetryOlderFailedRequestKeepsInterveningHistory(t *testing.T) {
	f := newFakeRuntime("r")
	f.startFn = func(context.Context, RuntimeRequest, func(Event) error) SubmitResult {
		return SubmitResult{Kind: SubmitNotSent}
	}
	c := testSession(t, f, nil)
	original := Request{MessageID: "failed", TurnID: "t0", Text: "failed request"}
	_, err := c.Start(context.Background(), original)
	expectErrIs(t, err, ErrUnconfirmed)
	f.mu.Lock()
	f.startFn = nil
	f.mu.Unlock()
	sendFake(t, c, "later")
	f.call(t, 1).complete(t, "intervening answer", Activity{Known: true})
	x := newFakeRuntime("codex")
	expectErrIs(t, c.Select(sessionTarget(x, "codex")), nil)
	original.Retry = true
	_, err = c.Start(context.Background(), original)
	expectErrIs(t, err, nil)
	plan := x.call(t, 0).request.Plan
	if ids := selectedIDs(plan); len(ids) != 2 || ids[0] != "later" || plan.Strategy != StrategyNewSession {
		t.Fatalf("old request order silently clipped newer live context: %v", ids)
	}
	if len(c.Messages()) != 3 {
		t.Fatal("explicit retry duplicated its logical request")
	}
}

func TestSessionEditedRevisionNeedsExplicitNewAttemptAndFreshNative(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	f.call(t, 0).complete(t, "old reply", Activity{Known: true})
	expectErrIs(t, c.Edit("u", "edited instruction"), nil)
	r := Request{MessageID: "u", TurnID: "turn_u", Text: "edited instruction"}
	_, err := c.Start(context.Background(), r)
	expectErrIs(t, err, ErrAlreadyExecuted)
	r.Retry = true
	_, err = c.Start(context.Background(), r)
	expectErrIs(t, err, nil)
	if f.call(t, 1).request.Plan.Strategy != StrategyNewSession || f.call(t, 1).request.Plan.TargetRev != 2 {
		t.Fatal("edited revision reused stale native state")
	}
	f.call(t, 1).complete(t, "new reply", Activity{Known: true})
	if len(c.Messages()) != 3 {
		t.Fatal("revision retry created another user entry")
	}
	_, err = c.Start(context.Background(), r)
	expectErrIs(t, err, ErrAlreadyExecuted)
}

func TestSessionConcurrentDuplicateCommandsAndCompletionAreSingleWriter(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	r := Request{MessageID: "u", TurnID: "t", Text: "one side effect"}
	results := make(chan error, 20)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := c.Start(context.Background(), r); results <- err }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrBusy) && !errors.Is(err, ErrAlreadyExecuted) {
			t.Fatal(err)
		}
	}
	_, starts, _ := f.counts()
	if success != 1 || starts != 1 || len(c.Messages()) != 1 {
		t.Fatal("concurrent request duplicated execution/transcript")
	}
	call := f.call(t, 0)
	expectErrIs(t, call.deliver(), nil)
	text := call.event(EventText)
	text.Text = "one reply"
	expectErrIs(t, call.emit(text), nil)
	results = make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			e := call.event(EventCompleted)
			e.Work = Activity{Known: true}
			results <- call.emit(e)
		}()
	}
	wg.Wait()
	close(results)
	success = 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrStaleEvent) {
			t.Fatal(err)
		}
	}
	if success != 1 || len(c.Messages()) != 2 {
		t.Fatal("duplicate completion wrote more than one assistant entry")
	}
}

func TestSessionCancelAfterCompletedIdleIsIdempotentNoOp(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	f.call(t, 0).complete(t, "done", Activity{Known: true})
	state, bindings := c.State(), c.Bindings()
	result, err := c.Cancel(context.Background())
	expectErrIs(t, err, nil)
	if result.Kind != CancelStopped || !reflect.DeepEqual(state, c.State()) || !reflect.DeepEqual(bindings, c.Bindings()) {
		t.Fatal("no-op cancel invalidated a valid idle binding")
	}
	f.mu.Lock()
	calls := f.cancels
	f.mu.Unlock()
	if calls != 0 {
		t.Fatal("idle cancel called native driver")
	}
}

func TestSessionValidUnknownDeliveryFencesWithoutCoverage(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	sendFake(t, c, "u")
	call := f.call(t, 0)
	e := call.event(EventDelivered)
	e.Delivery = Delivery{PlanID: call.request.Plan.ID, NativeSessionID: call.request.NativeSessionID, Kind: DeliveredUnknown}
	expectErrIs(t, call.emit(e), ErrUnknownState)
	if c.State().Phase != PhaseUncertain || len(c.Bindings()[0].Coverage.Delivered) != 0 {
		t.Fatal("unknown delivery acknowledged history or allowed replay")
	}
	expectErrIs(t, call.deliver(), ErrStaleEvent)
}

func TestSessionRejectsLossyUTF8CompatibilityIdentity(t *testing.T) {
	f := newFakeRuntime("r")
	c := testSession(t, f, nil)
	target := sessionTarget(f, "claude")
	target.Identity.Cwd = string([]byte{'/', 0xff})
	if err := c.Select(target); err == nil {
		t.Fatal("invalid UTF-8 cwd can alias a different JSON compatibility identity")
	}
	target = sessionTarget(f, "claude")
	target.Env.Model = string([]byte{0xff})
	if err := c.Select(target); err == nil {
		t.Fatal("invalid UTF-8 recovery-sensitive parameter accepted")
	}
	f.setRecovery(func(context.Context, RecoveryRequest) RecoveryResult {
		return RecoveryResult{Kind: RecoveryNew, NativeSessionID: string([]byte{0xff})}
	})
	_, err := c.Start(context.Background(), Request{MessageID: "u", TurnID: "t", Text: "request"})
	expectErrIs(t, err, ErrProtocol)
	_, starts, _ := f.counts()
	if starts != 0 {
		t.Fatal("invalid native identity reached submission")
	}
}
