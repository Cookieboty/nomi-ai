package conversationruntime

import (
	"context"
	"strings"
	"testing"
)

func TestSessionRewindMiddleUserEntryStalesDeliveredBindingAndHandsOffPriorOnly(t *testing.T) {
	f := newFakeRuntime("claude")
	c := testSession(t, f, nil)

	t1 := sendFake(t, c, "u1")
	f.call(t, 0).complete(t, "answer1", Activity{Known: true})
	t2 := sendFake(t, c, "u2")
	f.call(t, 1).complete(t, "answer2", Activity{Known: true})
	t3 := sendFake(t, c, "u3")
	f.call(t, 2).complete(t, "answer3", Activity{Known: true})

	oldBindingID := c.Bindings()[0].ID
	gen := c.State().Generation
	expectErrIs(t, c.Rewind("u2", &gen), nil)

	// Rewind tombstones u2, reply_a2, u3, reply_a3 while keeping u1 + reply_a1 live.
	var liveIDs []string
	var tombstoneIDs []string
	for _, e := range c.Messages() {
		if e.Tombstone {
			tombstoneIDs = append(tombstoneIDs, e.ID)
		} else {
			liveIDs = append(liveIDs, e.ID)
		}
	}
	r1 := "reply_" + t1.AttemptID
	r2 := "reply_" + t2.AttemptID
	r3 := "reply_" + t3.AttemptID
	if len(liveIDs) != 2 || liveIDs[0] != "u1" || liveIDs[1] != r1 {
		t.Fatalf("live entries after rewind = %v, want [u1 %s]", liveIDs, r1)
	}
	wantTomb := []string{"u2", r2, "u3", r3}
	if len(tombstoneIDs) != len(wantTomb) {
		t.Fatalf("tombstoned = %v, want %v", tombstoneIDs, wantTomb)
	}
	for i, w := range wantTomb {
		if tombstoneIDs[i] != w {
			t.Fatalf("tombstoned[%d] = %q, want %q", i, tombstoneIDs[i], w)
		}
	}

	b := c.Bindings()[0]
	if b.ID != oldBindingID || b.Status != StatusStale {
		t.Fatalf("delivered binding after middle rewind = %+v, want StatusStale", b)
	}
	for _, removed := range wantTomb {
		if _, has := b.Coverage.Delivered[removed]; has {
			t.Fatalf("stale binding still claimed delivered %q after rewind", removed)
		}
	}

	cp := c.Checkpoint()
	if err := ValidateCheckpoint(cp); err != nil {
		t.Fatalf("checkpoint invalid after rewind: %v", err)
	}
	if _, err := RestoreCheckpoint(cp); err != nil {
		t.Fatalf("checkpoint restore failed after rewind: %v", err)
	}

	// Next send must start a fresh native session carrying ONLY u1 + reply1 (never u2/u3).
	_, err := c.Start(context.Background(), Request{MessageID: "u2_edited", TurnID: "turn_u2_edited", Text: "edited u2"})
	expectErrIs(t, err, nil)
	call := f.call(t, 3)
	if call.request.Plan.Strategy != StrategyNewSession {
		t.Fatalf("post-rewind strategy = %q, want %q", call.request.Plan.Strategy, StrategyNewSession)
	}
	ids := selectedIDs(call.request.Plan)
	if len(ids) != 2 || ids[0] != "u1" || ids[1] != r1 {
		t.Fatalf("post-rewind selections = %v, want [u1 %s]", ids, r1)
	}
	if strings.Contains(call.request.Plan.Payload, "request u2") || strings.Contains(call.request.Plan.Payload, "answer2") {
		t.Fatalf("post-rewind payload leaked tombstoned turn: %s", call.request.Plan.Payload)
	}
	call.complete(t, "edited answer", Activity{Known: true})
}

func TestSessionRewindTrailingUndeliveredFailurePreservesIdleBinding(t *testing.T) {
	f := newFakeRuntime("claude")
	c := testSession(t, f, nil)

	sendFake(t, c, "u1")
	f.call(t, 0).complete(t, "answer1", Activity{Known: true})
	origNative := c.Bindings()[0].NativeSessionID
	beforeStatus := c.Bindings()[0].Status
	if !beforeStatus.Safe() {
		t.Fatalf("expected safe binding before trailing failure, got %s", beforeStatus)
	}

	f.mu.Lock()
	f.startFn = func(context.Context, RuntimeRequest, func(Event) error) SubmitResult {
		return SubmitResult{Kind: SubmitNotSent, Detail: "transient failure"}
	}
	f.mu.Unlock()
	_, err := c.Start(context.Background(), Request{MessageID: "u2", TurnID: "turn_u2", Text: "fail me"})
	expectErrIs(t, err, ErrUnconfirmed)
	if c.State().Phase != PhaseFailed || c.State().FailedRequest == nil {
		t.Fatalf("expected failed state with FailedRequest before rewind, got %+v", c.State())
	}

	expectErrIs(t, c.Rewind("u2", nil), nil)
	if c.State().Phase != PhaseIdle || c.State().FailedRequest != nil {
		t.Fatalf("rewind did not clear terminal failed attempt: %+v", c.State())
	}
	if b := c.Bindings()[0]; !b.Status.Safe() || b.Status != beforeStatus {
		t.Fatalf("unaffected prior binding became unsafe (%s, want %s) after trailing undelivered rewind", b.Status, beforeStatus)
	}

	f.mu.Lock()
	f.startFn = nil
	f.mu.Unlock()
	_, err = c.Start(context.Background(), Request{MessageID: "u2_fixed", TurnID: "turn_u2_fixed", Text: "fixed"})
	expectErrIs(t, err, nil)
	call := f.call(t, 2)
	if call.request.NativeSessionID != origNative || c.State().Recovery.Kind != RecoveryResumed {
		t.Fatalf("expected warm resume of unaffected native session %q, got %q (%s)", origNative, call.request.NativeSessionID, c.State().Recovery.Kind)
	}
	if strings.Contains(call.request.Plan.Payload, "fail me") {
		t.Fatalf("rewound failed message leaked into next turn payload: %s", call.request.Plan.Payload)
	}
}

func TestSessionRewindValidationAndGenerationGuards(t *testing.T) {
	f := newFakeRuntime("claude")
	c := testSession(t, f, nil)
	t1 := sendFake(t, c, "u1")
	r1 := "reply_" + t1.AttemptID
	f.call(t, 0).complete(t, "answer1", Activity{Known: true})

	expectErrIs(t, c.Rewind(r1, nil), ErrBadEdit)
	expectErrIs(t, c.Rewind("missing", nil), ErrUnknownEntry)
	stale := c.State().Generation - 1
	expectErrIs(t, c.Rewind("u1", &stale), ErrStaleEvent)

	// Reject rewind while busy.
	sendFake(t, c, "u2")
	expectErrIs(t, c.Rewind("u1", nil), ErrBusy)
	f.call(t, 1).complete(t, "answer2", Activity{Known: true})

	// Reject rewinding an already tombstoned user entry.
	expectErrIs(t, c.Rewind("u2", nil), nil)
	expectErrIs(t, c.Rewind("u2", nil), ErrBadEdit)
}
