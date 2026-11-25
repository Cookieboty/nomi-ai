package conversationruntime

import (
	"errors"
	"testing"
)

func TestPartialReceiptCannotClaimPreviouslyDeliveredGap(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "m", "old", "assistant", "ab😀cd") // UTF-8 [2,6) is one emoji
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t1", ""))
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredPartial, Parts: []DeliveredPart{{ID: "m", Rev: 1, Start: 2, End: 6}}}), nil)
	next := mustPlan(t, l, resume(get(t, s, b.ID), fakeIdent(), "q2", "t2", ""))
	if len(next.Selections) != 1 || len(next.Selections[0].Ranges) != 2 {
		t.Fatal("expected two unseen spans")
	}
	for _, part := range []DeliveredPart{
		{ID: "m", Rev: 1, Start: 0, End: 8}, // not a contiguous planned span
		{ID: "m", Rev: 1, Start: 2, End: 6}, // already delivered, not sent this time
		{ID: "m", Rev: 1, Start: 0, End: 3}, // splits emoji
		{ID: "m", Rev: 2, Start: 0, End: 2}, // wrong revision
	} {
		if err := l.Commit(s, next, Delivery{PlanID: next.ID, Kind: DeliveredPartial, Parts: []DeliveredPart{part}}); err == nil {
			t.Fatalf("invalid claim accepted %+v", part)
		}
	}
	// A rejected batch must not absorb even its valid first span.
	if err := l.Commit(s, next, Delivery{PlanID: next.ID, Kind: DeliveredPartial, Parts: []DeliveredPart{
		{ID: "m", Rev: 1, Start: 0, End: 2}, {ID: "m", Rev: 1, Start: 2, End: 6},
	}}); err == nil {
		t.Fatal("mixed batch accepted")
	}
	got := get(t, s, b.ID).Coverage.Partial["m"]
	if len(got.Ranges) != 1 || got.Ranges[0] != (ByteRange{2, 6}) {
		t.Fatal("rejected receipt changed coverage")
	}
	expectErrIs(t, l.Commit(s, next, Delivery{PlanID: next.ID, Kind: DeliveredFull, Parts: []DeliveredPart{{ID: "x", Rev: 99, Start: 0, End: 1}}}), ErrReceipt)
	accept(t, l, s, next)
	if !get(t, s, b.ID).Coverage.Covered("m", 1, TextDigest("ab😀cd"), 8) {
		t.Fatal("valid unseen delivery did not complete union")
	}
}

func TestDeliveredEditBlocksResumeAndPreservesAudit(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	old := appendMsg(t, l, "m", "old", "assistant", "old text")
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t1", ""))
	accept(t, l, s, p)
	edited, err := l.Edit(s, "m", "edited text")
	expectErrIs(t, err, nil)
	b = get(t, s, b.ID)
	if b.Status != StatusStale || len(b.Coverage.Delivered) != 0 {
		t.Fatal("native old text not invalidated")
	}
	if p := mustPlan(t, l, resume(b, fakeIdent(), "q2", "t2", "")); p.Strategy != StrategyBlocked {
		t.Fatal("edited native session resumed")
	}
	prior, _ := l.Revision(old.ID, 1)
	if prior.Text != old.Text || edited.Revision != 2 {
		t.Fatal("audit lost")
	}
	fresh := mustPlan(t, l, newSession(fakeIdent(), "q3", "t3", ""))
	if len(fresh.Selections) != 1 || fresh.Selections[0].Rev != 2 {
		t.Fatal("new session not based on edit")
	}
	_, err = l.Delete(s, old.ID)
	expectErrIs(t, err, nil)
	after := mustPlan(t, l, newSession(fakeIdent(), "q4", "t4", ""))
	if len(after.Selections) != 0 {
		t.Fatal("deleted entry handed off")
	}
	prior, _ = l.Revision(old.ID, 1)
	if prior.Text != old.Text {
		t.Fatal("delete destroyed old revision")
	}
}

func TestUnknownOutcomeBlocksWithoutCoverage(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t3", ""))
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredUnknown}), ErrUnconfirmed)
	b = get(t, s, b.ID)
	if b.Status != StatusUnknown || len(b.Coverage.Delivered) != 0 {
		t.Fatal("unknown outcome either claimed delivery or permits automatic retry")
	}
	if p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t3", "")); p.Strategy != StrategyBlocked {
		t.Fatal("uncertain turn automatically resumed")
	}
}

func TestCopiesCoverAllReadersAndMutationResults(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	e := appendMsg(t, l, "m", "t1", "assistant", "text", "asset:1")
	rev, _ := l.Revision(e.ID, e.Revision)
	rev.Attachments[0] = "mutated"
	snap := l.Snapshot()
	snap[0].Attachments[0] = "mutated"
	edit, err := l.Edit(s, e.ID, "edited")
	expectErrIs(t, err, nil)
	edit.Attachments[0] = "mutated"
	got, _ := l.Latest(e.ID)
	if got.Attachments[0] != "asset:1" {
		t.Fatal("read or edit result aliases storage")
	}
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	b.Coverage.Partial["x"] = PartialCoverage{Rev: 1, Ranges: []ByteRange{{0, 1}}}
	s2 := NewBindingStore()
	expectErrIs(t, s2.Put(b), nil)
	all := s2.All()
	all[0].Coverage.Partial["x"].Ranges[0].End = 999
	if get(t, s2, b.ID).Coverage.Partial["x"].Ranges[0].End != 1 {
		t.Fatal("All aliases nested ranges")
	}
}

func TestMalformedImportedCoverageDoesNotSplitUnicode(t *testing.T) {
	l := NewLedger()
	e := appendMsg(t, l, "m", "t1", "assistant", "😀x")
	b := Binding{ID: "b", NativeSessionID: "native", Status: StatusIdle, CompatKey: fakeIdent().Key(fakeEnv()), Coverage: NewCoverage()}
	b.Coverage.Partial[e.ID] = PartialCoverage{Rev: 1, Digest: TextDigest(e.Text), Ranges: []ByteRange{{1, 3}}}
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t2", ""))
	if len(p.Selections) != 1 || p.Selections[0].Ranges[0] != (ByteRange{0, 5}) {
		t.Fatal("malformed coverage not conservatively resent")
	}
}

func TestAttemptAndCompatibilityKeysCannotAlias(t *testing.T) {
	a, b := fakeIdent(), fakeIdent()
	a.ConfigDir = "a\x1fb"
	a.Cwd = "c"
	b.ConfigDir = "a"
	b.Cwd = "b\x1fc"
	if a.Key(fakeEnv()) == b.Key(fakeEnv()) {
		t.Fatal("delimiter collision in compatibility")
	}
	l := NewLedger()
	in := newSession(fakeIdent(), "q", "turn", "")
	in.AttemptID = "one"
	p := mustPlan(t, l, in)
	in.AttemptID = "two"
	next := mustPlan(t, l, in)
	if p.ID == next.ID {
		t.Fatal("different attempts aliased")
	}
}

func TestConfirmNativeRejectsWrongIdentityAndEditedRevision(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	e := appendMsg(t, l, "m", "t1", "assistant", "reply")
	if err := l.ConfirmNative(s, b.ID, "wrong", e.ID, e.Revision, TextDigest(e.Text)); err == nil {
		t.Fatal("wrong native source accepted")
	}
	expectErrIs(t, l.ConfirmNative(s, b.ID, b.NativeSessionID, e.ID, e.Revision, TextDigest(e.Text)), nil)
	_, err := l.Edit(s, e.ID, "edited")
	expectErrIs(t, err, nil)
	if err := l.ConfirmNative(s, b.ID, b.NativeSessionID, e.ID, 1, TextDigest(e.Text)); err == nil {
		t.Fatal("stale native reply accepted")
	}
	// Not just a failed assertion: original claim was actually revoked.
	if len(get(t, s, b.ID).Coverage.Delivered) != 0 {
		t.Fatal("stale coverage restored")
	}
	if err := s.Put(b); !errors.Is(err, ErrDuplicateBindID) {
		t.Fatal("Put clobbered existing native binding")
	}
}

func TestMutatedPlanCannotWidenCoverageBeyondPayload(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "m", "old", "assistant", "abcdef")
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t1", ""))
	p.Selections[0].Ranges[0].End = 3
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}), ErrPlanMismatch)
	if len(get(t, s, b.ID).Coverage.Delivered) != 0 {
		t.Fatal("mutated selection claimed delivery")
	}
}

func TestLateUnknownCannotDowngradeCommittedAttempt(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	p := mustPlan(t, l, resume(b, fakeIdent(), "q", "t3", ""))
	accept(t, l, s, p)
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredUnknown}), ErrAlreadyCommitted)
	if get(t, s, b.ID).Status != StatusLive {
		t.Fatal("late event downgraded committed state")
	}
}

func TestIncompleteIdentityBlocksEvenMatchingKey(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	id := fakeIdent()
	id.DriverVersion = ""
	b := newBinding(t, s, "b", id, fakeEnv())
	for _, target := range []RecoveryTarget{TargetCurrent, TargetNew, TargetResume} {
		in := resume(b, id, "q", "t3", "")
		in.Target = target
		p := mustPlan(t, l, in)
		if p.Strategy != StrategyBlocked {
			t.Fatal("incomplete native identity permitted execution")
		}
	}
}
