package conversationruntime

import (
	"strings"
	"sync"
	"testing"
)

// TestSwitchAwayAndBackResumesOriginalDelta drives new session -> commit ->
// other backend -> back through the public APIs only, then repeats.
func TestSwitchAwayAndBackResumesOriginalDelta(t *testing.T) {
	claude, codex := fakeIdent(), fakeIdent(func(id *NativeIdentity) {
		id.DriverID, id.Transport, id.Executable = "codex", "app-server", "/opt/fake/bin/codex"
	})
	l, s := twoExchanges(t), NewBindingStore()
	start := func(id string, ident NativeIdentity, turn, req string) Binding {
		cur := appendMsg(t, l, "u_"+turn, turn, "user", req)
		fresh := Binding{ID: id, CompatKey: ident.Key(fakeEnv()), Status: StatusIdle, Coverage: NewCoverage()}
		expectErrIs(t, s.Put(fresh), nil)
		in := newSession(ident, req, turn, cur.ID)
		in.Binding = fresh
		p := mustPlan(t, l, in)
		if p.Strategy != StrategyNewSession || p.Empty() {
			t.Fatalf("new session needs full history: %+v", p)
		}
		expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull, NativeSessionID: "native_" + id}), nil)
		// A duplicate confirmation of new-session delivery is also idempotent.
		expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull, NativeSessionID: "native_" + id}), nil)
		return get(t, s, id)
	}
	reply := func(b Binding, id, turn, text string) {
		e := appendMsg(t, l, id, turn, "assistant", text)
		expectErrIs(t, l.ConfirmNative(s, b.ID, b.NativeSessionID, e.ID, e.Revision, TextDigest(e.Text)), nil)
	}
	cb := start("nb_claude", claude, "t3", "hello claude")
	reply(cb, "a_t3", "t3", "claude answered")
	xb := start("nb_codex", codex, "t4", "hello codex")
	reply(xb, "a_t4", "t4", "codex answered")
	cur := appendMsg(t, l, "u_t5", "t5", "user", "what changed?")
	in := resume(get(t, s, cb.ID), claude, cur.Text, cur.TurnID, cur.ID)
	p := mustPlan(t, l, in)
	if ids := selectedIDs(p); p.Strategy != StrategyDelta || len(ids) != 2 || ids[0] != "u_t4" || ids[1] != "a_t4" {
		t.Fatalf("Claude must resume its original binding and see only Codex exchange: %v", ids)
	}
	accept(t, l, s, p)
	reply(get(t, s, cb.ID), "a_t5", "t5", "claude followed up")
	in = resume(get(t, s, xb.ID), codex, "and now?", "t6", "")
	p = mustPlan(t, l, in)
	if ids := selectedIDs(p); len(ids) != 2 || ids[0] != "u_t5" || ids[1] != "a_t5" {
		t.Fatalf("Codex delta: %v", ids)
	}
	accept(t, l, s, p)
	// No fabricated new messages: an unchanged ledger really has no unseen content.
	for i := 0; i < 2; i++ {
		p = mustPlan(t, l, resume(get(t, s, xb.ID), codex, "repeat", "t7", ""))
		if !p.Empty() || p.Strategy != StrategyNone || p.Payload != "repeat" {
			t.Fatalf("request-only resume: %+v", p)
		}
	}
	if get(t, s, cb.ID).NativeSessionID != cb.NativeSessionID || get(t, s, xb.ID).NativeSessionID != xb.NativeSessionID {
		t.Fatal("switch clobbered native bindings")
	}
}

// TestFallbackNewSessionNeverInheritsCoverage covers an identity-driven
// fallback and a Put attempt on an existing binding.
func TestFallbackNewSessionNeverInheritsCoverage(t *testing.T) {
	claude := fakeIdent()
	l, s := twoExchanges(t), NewBindingStore()
	deliverOn(t, l, s, "nb_first_session", claude)

	changed := fakeIdent(func(id *NativeIdentity) { id.LaunchFingerprint = "lf_second" })
	old := get(t, s, "nb_first_session")
	in := newSession(changed, "again", "t9", "")
	// Even accidentally supplied stale coverage MUST NOT suppress full history.
	in.Binding = old
	p := mustPlan(t, l, in)
	if p.Strategy != StrategyNewSession || len(p.Selections) != 4 || p.NativeSessionID != "" || p.BindingKey != changed.Key(fakeEnv()) {
		t.Fatalf("explicit fallback must carry bounded full: %+v", p)
	}
	if err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull, NativeSessionID: "new_native"}); err == nil {
		t.Fatal("fallback must not overwrite old binding")
	}
	if len(get(t, s, old.ID).Coverage.Delivered) != 4 {
		t.Fatal("old coverage lost")
	}
	fresh := Binding{ID: "nb_second", CompatKey: changed.Key(fakeEnv()), Status: StatusIdle, Coverage: NewCoverage()}
	expectErrIs(t, s.Put(fresh), nil)
	if got := get(t, s, "nb_second"); len(got.Coverage.Delivered)+len(got.Coverage.Partial) != 0 {
		t.Fatalf("fresh binding inherited coverage: %+v", got.Coverage)
	}
	overwrite := Binding{ID: "nb_second", CompatKey: changed.Key(fakeEnv()), NativeSessionID: "other",
		Status: StatusIdle, Coverage: NewCoverage()}
	expectErrIs(t, s.Put(overwrite), ErrDuplicateBindID)
	if got := get(t, s, "nb_second"); got.NativeSessionID != "" {
		t.Fatalf("Put overwrote an existing binding: %+v", got)
	}
	if _, ok := s.Get("nb_first_session"); !ok {
		t.Fatal("old binding must be kept")
	}
	expectErrIs(t, s.Put(Binding{ID: "nb_x", CompatKey: changed.Key(fakeEnv()), Status: StatusIdle}), nil)
	blocked := mustPlan(t, l, resume(get(t, s, "nb_x"), changed, "same id", "t9", ""))
	if blocked.Strategy != StrategyBlocked {
		t.Fatalf("session-less binding must block: %+v", blocked)
	}
}

// TestIdentityChangesBlockAndNeverClobber covers config, source, cwd and
// driver changes: they block, keep the old binding unchanged and give an
// explicit new binding empty coverage.
func TestIdentityChangesBlockAndNeverClobber(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	base := fakeIdent()
	bb := newBinding(t, s, "nb_base", base, fakeEnv())
	accept(t, l, s, mustPlan(t, l, resume(bb, base, "x", "t3", "")))
	before := get(t, s, "nb_base")
	if len(before.Coverage.Delivered) != 4 {
		t.Fatalf("setup delivered = %+v", before.Coverage.Delivered)
	}

	changes := []struct {
		name string
		mut  func(*NativeIdentity)
	}{
		{"config generation", func(id *NativeIdentity) { id.ConfigGen = 8 }},
		{"config dir", func(id *NativeIdentity) { id.ConfigDir = "/home/fake/.claude-2" }},
		{"source", func(id *NativeIdentity) { id.Source = "official" }},
		{"cwd", func(id *NativeIdentity) { id.Cwd = "/work/other" }},
		{"driver version", func(id *NativeIdentity) { id.DriverVersion = "2.0.2" }},
		{"executable", func(id *NativeIdentity) { id.Executable = "/opt/fake/bin/claude2" }},
		{"account", func(id *NativeIdentity) { id.AccountID = "acct_other" }},
	}
	for _, c := range changes {
		changed := fakeIdent(c.mut)
		if changed.Key(fakeEnv()) == base.Key(fakeEnv()) {
			t.Fatalf("%s change did not alter the compatibility key", c.name)
		}
		for _, target := range []RecoveryTarget{TargetCurrent, TargetResume} {
			in := resume(get(t, s, "nb_base"), changed, "after change", "t4", "")
			in.Target = target
			p := mustPlan(t, l, in)
			if p.Strategy != StrategyBlocked || !strings.Contains(p.Error, "incompatible") || len(p.Selections) != 0 {
				t.Fatalf("%s/%d: want blocked incompatible, got %s %q", c.name, target, p.Strategy, p.Error)
			}
			if err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}); err == nil {
				t.Fatalf("%s/%d: blocked plan must not commit", c.name, target)
			}
		}
		n := mustPlan(t, l, newSession(changed, "after change", "t4", ""))
		if n.Strategy != StrategyNewSession || len(n.Selections) != 4 {
			t.Fatalf("%s: explicit new session wanted, got %+v", c.name, n)
		}
		if after := get(t, s, "nb_base"); after.NativeSessionID != before.NativeSessionID ||
			len(after.Coverage.Delivered) != len(before.Coverage.Delivered) ||
			after.CompatKey != before.CompatKey || after.Status != before.Status {
			t.Fatalf("%s: old binding was clobbered: %+v", c.name, after)
		}
	}
}

// TestUnknownAndUncertainBindingsBlock checks every uncertain state blocks
// with an actionable error and commits nothing.
func TestUnknownAndUncertainBindingsBlock(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	states := []Status{StatusUnknown, StatusUnverified, StatusStale, ""}
	for _, st := range states {
		id := "nb_" + string(st)
		newBinding(t, s, id, ident, fakeEnv())
		setStatus(t, s, id, st)
		b := get(t, s, id)
		for _, target := range []RecoveryTarget{TargetCurrent, TargetResume} {
			in := resume(b, ident, "q", "t3", "")
			in.Target = target
			p := mustPlan(t, l, in)
			if p.Strategy != StrategyBlocked || p.Error == "" || len(p.Selections) != 0 || p.Handoff != "" {
				t.Fatalf("%q/%d must block, got %+v", st, target, p)
			}
			expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}), ErrUnknownState)
		}
	}
	// Explicit resolution: the caller starts a new session instead.
	if p := mustPlan(t, l, newSession(ident, "q", "t3", "")); p.Strategy != StrategyNewSession || len(p.Selections) != 4 {
		t.Fatalf("explicit new session after uncertainty: %+v", p)
	}
	// StatusUnknown must be resolved by the caller; a new binding is allowed
	// under a new id and starts empty.
	expectErrIs(t, s.Put(Binding{ID: "nb_resolved", CompatKey: ident.Key(fakeEnv()), Status: StatusIdle,
		Coverage: NewCoverage()}), nil)
}

func setStatus(t *testing.T, s *BindingStore, id string, st Status) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.b[id]
	b.Status = st
	s.b[id] = b
}

// TestPartialACKSubsetNotAbsorbed: a partial receipt claims only its typed
// spans, the rest is carried next time, and a repeated substring cannot widen
// the claim.
func TestPartialACKSubsetNotAbsorbed(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	text := "abcabcabc" // repeated-substring adversary
	e := appendMsg(t, l, "m1", "t1", "assistant", text)
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())

	p := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q", "t2", ""))
	if ids := selectedIDs(p); len(ids) != 1 || ids[0] != "m1" {
		t.Fatalf("plan = %v", ids)
	}
	d := Delivery{PlanID: p.ID, Kind: DeliveredPartial,
		Parts: []DeliveredPart{{ID: "m1", Rev: e.Revision, Start: 3, End: 6}}}
	expectErrIs(t, l.Commit(s, p, d), nil)
	got := get(t, s, "nb1")
	pc, ok := got.Coverage.Partial["m1"]
	if !ok || len(got.Coverage.Delivered) != 0 {
		t.Fatalf("partial must be recorded as partial only: %+v", got.Coverage)
	}
	if len(pc.Ranges) != 1 || pc.Ranges[0] != (ByteRange{3, 6}) || pc.Digest != TextDigest(text) || pc.Rev != 1 {
		t.Fatalf("partial ranges = %+v", pc)
	}
	// Identical repeat is idempotent; a conflicting repeat is rejected.
	expectErrIs(t, l.Commit(s, p, d), nil)
	other := Delivery{PlanID: p.ID, Kind: DeliveredPartial,
		Parts: []DeliveredPart{{ID: "m1", Rev: 1, Start: 0, End: 3}}}
	expectErrIs(t, l.Commit(s, p, other), ErrAlreadyCommitted)
	if after := get(t, s, "nb1"); after.Coverage.Partial["m1"].Ranges[0] != (ByteRange{3, 6}) {
		t.Fatalf("rejected repeat changed coverage: %+v", after.Coverage)
	}

	// Next plan carries the unseen head and tail only, with explicit span labels.
	p2 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q2", "t3", ""))
	if len(p2.Selections) != 1 || len(p2.Selections[0].Ranges) != 2 || p2.Selections[0].Ranges[0] != (ByteRange{0, 3}) || p2.Selections[0].Ranges[1] != (ByteRange{6, 9}) {
		t.Fatalf("delta must carry the remaining whole entry: %q", p2.Handoff)
	}
	cover := Delivery{PlanID: p2.ID, Kind: DeliveredPartial, Parts: []DeliveredPart{
		{ID: "m1", Rev: 1, Start: 0, End: 3}, {ID: "m1", Rev: 1, Start: 6, End: 9},
	}}
	expectErrIs(t, l.Commit(s, p2, cover), nil)
	if fc := get(t, s, "nb1").Coverage; fc.Delivered["m1"].Rev != 1 || fc.Delivered["m1"].Digest != TextDigest(text) {
		t.Fatalf("covering the union must become full delivery: %+v", fc)
	}
	p3 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q3", "t4", ""))
	if !p3.Empty() || p3.Strategy != StrategyNone {
		t.Fatalf("nothing unseen left: %v", selectedIDs(p3))
	}
}

// TestReceiptOutsidePlanRejected: claims that are not part of the plan can
// never be recorded, and a batch with one bad item commits nothing.
func TestReceiptOutsidePlanRejected(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	e1 := appendMsg(t, l, "m1", "t1", "assistant", "hello")
	e2 := appendMsg(t, l, "m2", "t1", "assistant", "secret", "asset:omitted")
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	before := get(t, s, "nb1")

	p := mustPlan(t, l, resume(before, ident, "q", "t2", ""))
	if len(p.Selections) != 1 {
		t.Fatalf("plan = %v", selectedIDs(p))
	}
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: "pl_other", Kind: DeliveredFull}), ErrPlanMismatch)
	cases := map[string][]DeliveredPart{
		"unknown entry":    {{ID: "m9", Rev: 1, Start: 0, End: 1}},
		"unknown revision": {{ID: "m1", Rev: 2, Start: 0, End: 1}},
		"beyond text":      {{ID: "m1", Rev: e1.Revision, Start: 0, End: 99}},
		"outside planned":  {{ID: "m2", Rev: e2.Revision, Start: 0, End: 3}},
		"reversed span":    {{ID: "m1", Rev: e1.Revision, Start: 3, End: 1}},
	}
	for name, parts := range cases {
		err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredPartial, Parts: parts})
		if err == nil || (!errorsIs(err, ErrReceipt) && !errorsIs(err, ErrInvalidRange)) {
			t.Fatalf("%s: want receipt/range error, got %v", name, err)
		}
	}
	// One good and one bad part: the whole batch is rejected.
	good := DeliveredPart{ID: "m1", Rev: e1.Revision, Start: 0, End: 5}
	bad := DeliveredPart{ID: "m2", Rev: e2.Revision, Start: 0, End: 3}
	if err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredPartial,
		Parts: []DeliveredPart{good, bad}}); err == nil {
		t.Fatal("bad batch accepted")
	}
	if after := get(t, s, "nb1"); len(after.Coverage.Delivered)+len(after.Coverage.Partial) != 0 ||
		after.NativeSessionID != before.NativeSessionID || after.Status != before.Status {
		t.Fatalf("rejected batch mutated the binding: %+v", after)
	}
	// Unconfirmed kinds never advance coverage.
	for _, k := range []DeliveryKind{DeliveredUnknown, DeliveredPreSubmitFailed} {
		expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: k}), ErrUnconfirmed)
	}
	if after := get(t, s, "nb1"); len(after.Coverage.Partial) != 0 {
		t.Fatal("unconfirmed delivery advanced coverage")
	}
}

// TestStaleAfterEditRejectsWithoutDeadlock edits an entry between plan and
// commit: the commit fails without deadlocking or touching coverage.
func TestStaleAfterEditRejectsWithoutDeadlock(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	b := newBinding(t, s, "nb1", ident, fakeEnv())
	p := mustPlan(t, l, resume(b, ident, "q", "t3", ""))
	if _, err := l.Edit(s, "u_t1", "explain the build (edited)"); err != nil {
		t.Fatalf("edit: %v", err)
	}
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}), ErrStalePlan)
	got := get(t, s, "nb1")
	if len(got.Coverage.Delivered)+len(got.Coverage.Partial) != 0 {
		t.Fatalf("stale commit advanced coverage: %+v", got.Coverage)
	}
	if got.InvalidatedByRev["u_t1"] != 2 {
		t.Fatalf("invalidation must be keyed by entry id at the edit revision: %+v", got.InvalidatedByRev)
	}
	// A fresh plan after the edit carries the new revision only.
	p2 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q", "t3", ""))
	found := false
	for _, sel := range p2.Selections {
		if sel.ID == "u_t1" {
			found = true
			if sel.Rev != 2 || !strings.Contains(p2.Handoff, "edited") {
				t.Fatalf("post-edit plan must use revision 2: %+v", sel)
			}
		}
	}
	if !found {
		t.Fatalf("edited entry missing from the delta: %v", selectedIDs(p2))
	}
	accept(t, l, s, p2)
}

// TestStalenessUsesEntryRevisions: editing the current request entry after
// planning must invalidate the complete payload, even if history is unchanged.
func TestStalenessUsesEntryRevisions(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	b := newBinding(t, s, "nb1", ident, fakeEnv())
	req := appendMsg(t, l, "u_t3", "t3", "user", "the request")
	p := mustPlan(t, l, resume(b, ident, "the request", "t3", req.ID))
	if _, err := l.Edit(s, "u_t3", "the request, reworded"); err != nil {
		t.Fatal(err)
	}
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}), ErrStalePlan)
	if got := get(t, s, "nb1"); len(got.Coverage.Delivered) != 0 {
		t.Fatalf("delivered = %+v", got.Coverage.Delivered)
	}
	// The same happens with a newer unrelated request revision.
	setStatus(t, s, "nb1", StatusLive)
	p2 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "another", "t4", ""))
	expectErrIs(t, l.Commit(s, p2, Delivery{PlanID: p2.ID, Kind: DeliveredFull}), nil)
}

// TestEditInvalidatesPartial: an edit must catch Partial coverage of the old
// revision as well as Delivered.
func TestEditInvalidatesPartial(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "m1", "t1", "assistant", "abcdef")
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	p := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q", "t2", ""))
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredPartial,
		Parts: []DeliveredPart{{ID: "m1", Rev: 1, Start: 0, End: 2}}}), nil)
	if _, ok := get(t, s, "nb1").Coverage.Partial["m1"]; !ok {
		t.Fatal("partial coverage missing")
	}
	if _, err := l.Edit(s, "m1", "XYZ"); err != nil {
		t.Fatal(err)
	}
	got := get(t, s, "nb1")
	if _, ok := got.Coverage.Partial["m1"]; ok {
		t.Fatalf("partial coverage of the old revision survived the edit: %+v", got.Coverage)
	}
	if got.InvalidatedByRev["m1"] != 2 {
		t.Fatalf("invalidation boundary = %+v", got.InvalidatedByRev)
	}
	expectErrIs(t, l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}), ErrStalePlan)
}

// TestNativeSessionIdentityIsImmutable: a receipt reporting another native
// identity must not replace the binding's identity.
func TestNativeSessionIdentityIsImmutable(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	b := get(t, s, "nb1")
	p := mustPlan(t, l, resume(b, ident, "q", "t3", ""))
	err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull, NativeSessionID: "native_of_another_session"})
	if err == nil {
		t.Fatal("a different native identity was accepted as confirmation")
	}
	got := get(t, s, "nb1")
	if got.NativeSessionID != b.NativeSessionID {
		t.Fatalf("native session was clobbered: %q -> %q", b.NativeSessionID, got.NativeSessionID)
	}
	if len(got.Coverage.Delivered)+len(got.Coverage.Partial) != 0 {
		t.Fatalf("mismatched identity receipt advanced coverage: %+v", got.Coverage)
	}
	// No confirmed native identity: resume blocks, explicit new can learn it once.
	anon := Binding{ID: "nb_anon", CompatKey: ident.Key(fakeEnv()), Status: StatusIdle, Coverage: NewCoverage()}
	expectErrIs(t, s.Put(anon), nil)
	blocked := mustPlan(t, l, resume(anon, ident, "q", "t3", ""))
	if blocked.Strategy != StrategyBlocked {
		t.Fatal("resume without identity must block")
	}
	in := newSession(ident, "q", "t3", "")
	in.Binding = anon
	p2 := mustPlan(t, l, in)
	expectErrIs(t, l.Commit(s, p2, Delivery{PlanID: p2.ID, Kind: DeliveredFull, NativeSessionID: "native_s1"}), nil)
	if get(t, s, anon.ID).NativeSessionID != "native_s1" {
		t.Fatal("new session identity not learned")
	}

}

// TestOmittedNotAbsorbedAndBackfilled: a tight budget omits with markers,
// coverage is untouched, and the same seeded delta plus a larger budget
// backfills exactly the omitted entries under a NEW plan fingerprint.
func TestOmittedNotAbsorbedAndBackfilled(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		appendMsg(t, l, id, "t1", "assistant", strings.Repeat(id, 40))
	}
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	tight := resume(get(t, s, "nb1"), ident, "go", "t3", "")
	tight.Budget = 260
	p := mustPlan(t, l, tight)
	if p.Empty() {
		t.Fatal("260 bytes must still carry one entry")
	}
	sel := selectedIDs(p)
	reasons := omissionReasons(p)
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		if has(sel, id) {
			continue
		}
		if reasons[id] != ReasonBudget {
			t.Fatalf("%s omitted for %q, want budget: %v", id, reasons[id], reasons)
		}
		if o := findOmission(p, id); o.Reported && !strings.Contains(p.Handoff, "[omitted "+id+"@") {
			t.Fatalf("named omission %s has no marker in the handoff: %q", id, p.Handoff)
		}
	}
	if n := omissionCount(p.Handoff); n != reportedOmissions(p) {
		t.Fatalf("handoff has %d omission markers but plan lists %d", n, len(p.Omitted))
	}
	accept(t, l, s, p)
	got := get(t, s, "nb1")
	if len(got.Coverage.Delivered)+len(got.Coverage.Partial) != len(sel) {
		t.Fatalf("only selected entries may be covered: %+v", got.Coverage)
	}
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		if _, ok := got.Coverage.Delivered[id]; ok && !has(sel, id) {
			t.Fatalf("omitted %s absorbed into coverage", id)
		}
	}

	// A seeded larger budget backfills exactly the omitted entries.
	roomy := tight
	roomy.Budget = 1 << 20
	roomy.Binding = get(t, s, "nb1")
	var omitted []string
	for _, o := range p.Omitted {
		omitted = append(omitted, o.ID)
	}
	p2 := mustPlan(t, l, roomy)
	if len(p2.Omitted) != 0 {
		t.Fatalf("larger budget still omits: %v", omissionReasons(p2))
	}
	if ids := selectedIDs(p2); len(ids) != len(omitted) {
		t.Fatalf("backfill = %v, want %v", ids, omitted)
	} else {
		for _, id := range omitted {
			if !has(ids, id) {
				t.Fatalf("backfill %v misses %s", ids, id)
			}
		}
	}
	if p2.ID == p.ID {
		t.Fatal("changed selection must have a new plan fingerprint")
	}
}

// TestPayloadBudgetBoundsActualPayload checks that the budget bounds the true
// serialized payload across unicode, JSON escaping and tight budgets.
func TestPayloadBudgetBoundsActualPayload(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	texts := []string{`quote " and backslash \ end \`, "中文句子里有 emoji 😀🎉 和制表符\t换行\n", strings.Repeat("x", 40)}
	for i, tx := range texts {
		appendMsg(t, l, "m"+itoa(i), "t1", "assistant", tx)
	}
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	b := get(t, s, "nb1")
	full := mustPlan(t, l, resume(b, ident, "req", "t2", ""))
	if len(full.Selections) != 3 {
		t.Fatalf("setup = %v", selectedIDs(full))
	}
	exact := ByteBudget(full.PayloadBytes)
	if p := planWithBudget(t, l, b, ident, exact); p.PayloadBytes != int(exact) || p.Empty() {
		t.Fatalf("exactly-sized budget must carry the full plan: %d vs %d", p.PayloadBytes, exact)
	}
	for budget := ByteBudget(jsonLen("req")); budget <= exact; budget++ {
		p := planWithBudget(t, l, b, ident, budget)
		if p.PayloadBytes > int(budget) {
			t.Fatalf("budget %d exceeded by %d", budget, p.PayloadBytes)
		}
		if !p.Empty() && !jsonEncodedSize(p) {
			t.Fatalf("payload size mismatch at budget %d", budget)
		}
	}
}

func jsonEncodedSize(p Plan) bool { return p.PayloadBytes == jsonLen(p.Payload) }

func planWithBudget(t *testing.T, l *Ledger, b Binding, ident NativeIdentity, budget ByteBudget) Plan {
	t.Helper()
	in := resume(b, ident, "req", "t2", "")
	in.Budget = budget
	p, err := l.Plan(in)
	if err != nil {
		t.Fatalf("plan with budget %d: %v", budget, err)
	}
	assertPayload(t, p, budget)
	return p
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var out []byte
	for n > 0 {
		out = append([]byte{byte('0' + n%10)}, out...)
		n /= 10
	}
	return string(out)
}

// TestRequestBudgetExactAndZero: zero budget, a budget that exactly fits the
// request (no history room), and an over-budget request.
func TestRequestBudgetExactAndZero(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	b := get(t, s, "nb1")
	req := "hello 中文 😀 \"quoted\"\n"
	need := jsonLen(req)
	if need != 32 {
		t.Fatalf("json size of %q = %d", req, need)
	}

	in := resume(b, ident, req, "t3", "")
	in.Budget = ByteBudget(need)
	p := mustPlan(t, l, in)
	if !p.Empty() || p.Handoff != "" || p.PayloadBytes != need || len(p.Omitted) != 4 {
		t.Fatalf("exact request budget leaves no history room: %+v", p)
	}
	if p.Strategy != StrategyNone || p.RequestBody != req || p.RequestBytes != need {
		t.Fatalf("request must be carried once, untruncated: %+v", p)
	}

	in.Budget = ByteBudget(need - 1)
	_, err := l.Plan(in)
	var over *ErrBudget
	if !asBudget(err, &over) || over.Need != need || over.Limit != need-1 || !strings.Contains(err.Error(), "shorten") {
		t.Fatalf("want actionable ErrBudget, got %v", err)
	}

	in.RequestText, in.Budget = "", 0
	if _, err := l.Plan(in); err == nil {
		t.Fatal("JSON empty string costs 2 bytes; zero must fail")
	}
	in.RequestText = "x"
	if _, err := l.Plan(in); err == nil {
		t.Fatal("zero budget with a non-empty request must be refused")
	}
}

func asBudget(err error, out **ErrBudget) bool {
	for err != nil {
		if e, ok := err.(*ErrBudget); ok {
			*out = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// TestManyEntriesOmissionOverheadBudget stresses omission-marker overhead with
// many tiny entries where markers, wrapper and separators alone matter.
func TestManyEntriesOmissionOverheadBudget(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	for i := 0; i < 40; i++ {
		appendMsg(t, l, "m"+itoa(i), "t1", "assistant", "msg "+itoa(i))
	}
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	b := get(t, s, "nb1")
	for _, budget := range []ByteBudget{10, 40, 60, 100, 150, 300, 1000, 2000} {
		p := planWithBudget(t, l, b, ident, budget)
		if !p.Empty() && p.PayloadBytes > int(budget) {
			t.Fatalf("budget %d exceeded: %d", budget, p.PayloadBytes)
		}
		if n := omissionCount(p.Handoff); n != reportedOmissions(p) {
			t.Fatalf("budget %d: %d markers vs %d omissions", budget, n, len(p.Omitted))
		}
		for _, o := range p.Omitted {
			if o.Reported && !strings.Contains(p.Handoff, "[omitted "+o.ID+"@") {
				t.Fatalf("budget %d: omission %s not described in the handoff %q", budget, o.ID, p.Handoff)
			}
		}
	}
}

// TestCurrentRequestPreservedExactlyOnce: the current request (by stable ID
// or turn) never appears in the handoff, is carried once, and its lineage is
// promoted on a confirmed commit.
func TestCurrentRequestPreservedExactlyOnce(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	b := get(t, s, "nb1")
	cur := appendMsg(t, l, "u_t3", "t3", "user", "what next, 下一步?")
	in := resume(b, ident, "what next, 下一步?", "t3", cur.ID)
	in.RequestInLedger = true
	p := mustPlan(t, l, in)
	if strings.Contains(p.Handoff, "下一步") {
		t.Fatalf("current request leaked into the handoff: %q", p.Handoff)
	}
	if strings.Count(p.RequestBody, "下一步") != 1 || strings.Contains(p.Handoff, "u_t3@") {
		t.Fatalf("request must be carried exactly once and not as history: %+v", p)
	}
	if p.Lineage == nil || p.Lineage.ID != "u_t3" || p.Lineage.Rev != 1 {
		t.Fatalf("lineage of the stored request = %+v", p.Lineage)
	}
	if p.TargetRev != 1 || p.TargetDigest != TextDigest("what next, 下一步?") {
		t.Fatalf("target identity = %d/%s", p.TargetRev, p.TargetDigest)
	}
	// Matching by turn alone works too.
	byTurn := mustPlan(t, l, resume(b, ident, "what next, 下一步?", "t3", ""))
	if has(selectedIDs(byTurn), "u_t3") || byTurn.Lineage == nil {
		t.Fatalf("turn-based exclusion: %v %+v", selectedIDs(byTurn), byTurn.Lineage)
	}
	// RequestInLedger with a missing entry is an error, never a guess.
	bad := resume(b, ident, "x", "", "u_missing")
	bad.RequestInLedger = true
	if _, err := l.Plan(bad); err == nil {
		t.Fatal("RequestInLedger with a missing entry must fail")
	}
	// A confirmed commit promotes the lineage instead of resending it.
	accept(t, l, s, p)
	if d, ok := get(t, s, "nb1").Coverage.Delivered["u_t3"]; !ok || d.Rev != 1 {
		t.Fatalf("lineage not promoted: %+v", get(t, s, "nb1").Coverage)
	}
	p2 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "what next, 下一步?", "t3", cur.ID))
	if !p2.Empty() || p2.Strategy != StrategyNone {
		t.Fatalf("after promotion nothing is left: %v", selectedIDs(p2))
	}
}

// TestAttachmentsOmittedAndCurrentRefused: historical attachments keep the
// text and list the omission; current attachments refuse before execution.
func TestAttachmentsOmittedAndCurrentRefused(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "u_img", "t1", "user", "look at this", "asset:abc")
	appendMsg(t, l, "u_txt", "t1", "user", "plain text")
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	p := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "next", "t2", ""))
	if omissionReasons(p)["u_img"] != ReasonAttachment {
		t.Fatalf("historical attachment omission = %v", omissionReasons(p))
	}
	if strings.Contains(p.Handoff, "look at this") {
		t.Fatal("attachment-bearing text was absorbed")
	}
	if !strings.Contains(p.Handoff, "[omitted u_img@1 attachment]") {
		t.Fatalf("attachment omission not listed: %q", p.Handoff)
	}
	if !strings.Contains(p.Handoff, "plain text") {
		t.Fatalf("plain text lost: %q", p.Handoff)
	}
	in := resume(get(t, s, "nb1"), ident, "see image", "t2", "")
	in.Attachments = []string{"asset:xyz"}
	if _, err := l.Plan(in); err == nil || !strings.Contains(err.Error(), "attachment") {
		t.Fatalf("current attachment must be refused, got %v", err)
	}
	// Never silently dropped for a new session either.
	in.Target = TargetNew
	if _, err := l.Plan(in); err == nil {
		t.Fatal("current attachment must be refused for a new session too")
	}
}

// TestOversizedEntryOmittedWhole: a whole-entry selection limit omits an
// entry too large for the budget and never sends part of it.
func TestOversizedEntryOmittedWhole(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "big", "t1", "assistant", strings.Repeat("巨", 200))
	appendMsg(t, l, "small", "t1", "user", "ok")
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	in := resume(get(t, s, "nb1"), ident, "q", "t2", "")
	in.Budget = 200
	p := mustPlan(t, l, in)
	if has(selectedIDs(p), "big") {
		t.Fatal("oversized entry must not be selected")
	}
	if omissionReasons(p)["big"] != ReasonBudget {
		t.Fatalf("omissions = %v", omissionReasons(p))
	}
	if strings.Contains(p.Handoff, "巨") {
		t.Fatal("partial text of an entry was sent")
	}
	if !has(selectedIDs(p), "small") {
		t.Fatalf("small entry should fit: %v", selectedIDs(p))
	}
	// Unchanged inputs plan identically (deterministic, pending retry).
	if again := mustPlan(t, l, in); again.ID != p.ID || again.Handoff != p.Handoff {
		t.Fatal("planning is not deterministic")
	}
}

// TestDefensiveCopiesAndConcurrentEditCommit exercises aliasing and the
// store/ledger lock order under -race.
func TestDefensiveCopiesAndConcurrentEditCommit(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "m1", "t1", "assistant", "abcdef")
	att := []string{"asset:1"}
	if _, err := l.Append(Entry{ID: "m2", TurnID: "t1", Role: "user", Origin: "api", Text: "hi", Attachments: att}); err != nil {
		t.Fatal(err)
	}
	att[0] = "mutated"
	if got, _ := l.Latest("m2"); got.Attachments[0] != "asset:1" {
		t.Fatal("Append aliased the caller's attachments")
	}
	got, _ := l.Latest("m2")
	got.Attachments[0] = "mutated-again"
	if again, _ := l.Latest("m2"); again.Attachments[0] != "asset:1" {
		t.Fatal("Latest handed out an aliased slice")
	}
	cov := NewCoverage()
	cov.Partial["x"] = PartialCoverage{Rev: 1, Digest: "d", Ranges: []ByteRange{{0, 1}}}
	inv := map[string]int{"e": 2}
	if err := s.Put(Binding{ID: "nbx", CompatKey: "k", Status: StatusIdle, Coverage: cov, InvalidatedByRev: inv}); err != nil {
		t.Fatal(err)
	}
	cov.Partial["x"] = PartialCoverage{Rev: 2}
	inv["e"] = 99
	gb := get(t, s, "nbx")
	if gb.InvalidatedByRev["e"] != 2 || gb.Coverage.Partial["x"].Rev != 1 {
		t.Fatal("Put aliased caller maps")
	}
	gb.Coverage.Partial["x"].Ranges[0].End = 5
	gb.InvalidatedByRev["e"] = 7
	if gb2 := get(t, s, "nbx"); gb2.Coverage.Partial["x"].Ranges[0].End != 1 || gb2.InvalidatedByRev["e"] != 2 {
		t.Fatal("Get handed out aliased state")
	}

	ident := fakeIdent()
	newBinding(t, s, "nbc", ident, fakeEnv())
	plan := mustPlan(t, l, resume(get(t, s, "nbc"), ident, "q", "t2", ""))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = l.Commit(s, plan, Delivery{PlanID: plan.ID, Kind: DeliveredPartial,
				Parts: []DeliveredPart{{ID: "m1", Rev: 1, Start: 0, End: 1}}})
		}()
		go func() {
			defer wg.Done()
			_, _ = l.Edit(s, "m1", strings.Repeat("z", 5))
		}()
	}
	wg.Wait()
	fin := get(t, s, "nbc")
	latest, _ := l.Latest("m1")
	if d, ok := fin.Coverage.Delivered["m1"]; ok && d.Rev < latest.Revision {
		t.Fatalf("coverage kept an edited revision: %+v latest %d", d, latest.Revision)
	}
	if p, ok := fin.Coverage.Partial["m1"]; ok && p.Rev < latest.Revision {
		t.Fatalf("partial coverage kept an edited revision: %+v latest %d", p, latest.Revision)
	}
	if fin.InvalidatedByRev["m1"] != latest.Revision {
		t.Fatalf("boundary = %+v, latest = %d", fin.InvalidatedByRev, latest.Revision)
	}
	// The concurrency must have converged on consistent state regardless of
	// which side won: a live binding continued afterwards plans only the new
	// revision.
	cont := mustPlan(t, l, resume(fin, ident, "q", "t3", ""))
	for _, sel := range cont.Selections {
		if sel.ID == "m1" && sel.Rev != latest.Revision {
			t.Fatalf("continued plan carries revision %d, latest %d", sel.Rev, latest.Revision)
		}
	}
}

// TestUTF16AndArgvUnitsStaySeparate covers the separate logical UTF-16 and
// Windows argv units and computed quoting cost.
func TestUTF16AndArgvUnitsStaySeparate(t *testing.T) {
	if UTF16Len("a中😀") != 4 {
		t.Fatalf("utf16 units = %d", UTF16Len("a中😀"))
	}
	if UTF16QuotedLen(`a b`) != 5 {
		t.Fatalf("plain quoting = %d", UTF16QuotedLen(`a b`))
	}
	if got := UTF16QuotedLen(`say "hi"`); got != UTF16Len(`say "hi"`)+4 {
		t.Fatalf("quote cost = %d, want +4", got)
	}
	if got := UTF16QuotedLen(`dir\`); got != 7 {
		t.Fatalf("trailing backslash cost = %d, want 7", got)
	}
	if got := UTF16QuotedLen(`a\"b`); got != 8 {
		t.Fatalf(`a\"b cost = %d, want 8`, got)
	}
	expectErrIs(t, CheckUTF16("a中😀", 4), nil)
	if err := CheckUTF16("a中😀", 3); err == nil {
		t.Fatal("over-limit logical text must be refused against its own limit")
	}
	prompt := `say "x"`
	base := UTF16QuotedLen(prompt) + 1 + UTF16QuotedLen("-p") + 1 + UTF16QuotedLen(`dir\`) + 1
	if err := CheckArgv(prompt, []string{"-p", `dir\`}, ArgvBudget(base)); err != nil {
		t.Fatalf("argv within limit: %v", err)
	}
	if err := CheckArgv(prompt, []string{"-p", `dir\`}, ArgvBudget(base-1)); err == nil {
		t.Fatal("argv over limit must be refused")
	}
	if err := CheckArgvText(strings.Repeat(`"`, 10), 20); err == nil {
		t.Fatal("quote-heavy element over the limit must be refused")
	}
}

// TestPlanFingerprintCoversIdentityAndSelection: plans differing only in
// binding, request identity or selection do not share an ID.
func TestPlanFingerprintCoversIdentityAndSelection(t *testing.T) {
	l, s := twoExchanges(t), NewBindingStore()
	ident := fakeIdent()
	newBinding(t, s, "nb1", ident, fakeEnv())
	newBinding(t, s, "nb2", ident, fakeEnv())
	p1 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q", "t3", ""))
	p2 := mustPlan(t, l, resume(get(t, s, "nb2"), ident, "q", "t3", ""))
	if p1.ID == p2.ID {
		t.Fatal("different bindings produced the same plan ID")
	}
	p3 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q2", "t3", ""))
	if p3.ID == p1.ID {
		t.Fatal("different request produced the same plan ID")
	}
	accept(t, l, s, p1)
	p4 := mustPlan(t, l, resume(get(t, s, "nb1"), ident, "q", "t3", ""))
	if p4.ID == p1.ID {
		t.Fatal("different selection produced the same plan ID")
	}
	if again := mustPlan(t, l, resume(get(t, s, "nb2"), ident, "q", "t3", "")); again.ID != p2.ID || again.Handoff != p2.Handoff {
		t.Fatal("planning is not deterministic")
	}
}
