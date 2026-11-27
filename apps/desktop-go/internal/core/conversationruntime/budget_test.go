package conversationruntime

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

// The independent oracle is the EXACT JSON string sent, not a sum of estimates
// for history/request. JSON escaping, separators and wrapper are non-additive.
func TestCompletePayloadExactBoundary(t *testing.T) {
	l := NewLedger()
	e := appendMsg(t, l, "m", "old", "user", "中😀\n\"\\<&>")
	in := newSession(fakeIdent(), "问😀\"\n", "next", "")
	in.Wrapper = HandoffWrapper{Prefix: "<h>\n", Suffix: "\n</h>"}
	wantH := "<h>\n[user m@1] " + e.Text + "\n</h>"
	want := wantH + "\n" + in.RequestText
	encoded, _ := json.Marshal(want)
	in.Budget = ByteBudget(len(encoded))
	p := mustPlan(t, l, in)
	if p.Payload != want || p.Handoff != wantH || p.PayloadBytes != len(encoded) || len(p.Selections) != 1 {
		t.Fatalf("exact complete payload got %+v, want %q (%d bytes)", p, want, len(encoded))
	}
	in.Budget--
	p = mustPlan(t, l, in)
	if len(p.Selections) != 0 || len(p.Omitted) != 1 {
		t.Fatal("one byte short must defer the whole selection")
	}
	if jsonLen(p.Payload) > int(in.Budget) {
		t.Fatal("one-byte-short prompt exceeds limit")
	}
	if strings.Count(p.Payload, in.RequestText) != 1 {
		t.Fatal("current request changed or duplicated")
	}
}

func TestEveryBudgetFullAndDeltaUnicode(t *testing.T) {
	for _, target := range []RecoveryTarget{TargetNew, TargetResume} {
		l, s := NewLedger(), NewBindingStore()
		for i, text := range []string{"中😀\n\"<&>", strings.Repeat("大", 90), "tiny", `slashes\\and"quotes`} {
			appendMsg(t, l, "m"+itoa(i), "old", "assistant", text)
		}
		b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
		in := resume(b, fakeIdent(), "CURRENT😀\n", "next", "")
		in.Target = target
		full := mustPlan(t, l, in)
		for budget := 0; budget <= full.PayloadBytes+1; budget++ {
			in.Budget = ByteBudget(budget)
			p, err := l.Plan(in)
			if budget < jsonLen(in.RequestText) {
				var over *ErrBudget
				if !errors.As(err, &over) {
					t.Fatalf("target %d budget %d: expected request refusal: %v", target, budget, err)
				}
				if len(p.Selections) > 0 {
					t.Fatal("failed preparation selected history")
				}
				continue
			}
			if err != nil {
				t.Fatalf("target %d budget %d: %v", target, budget, err)
			}
			assertPayload(t, p, in.Budget)
			if !utf8.ValidString(p.Payload) || strings.Count(p.Payload, in.RequestText) != 1 {
				t.Fatal("lost, duplicated or split request")
			}
			if len(p.Selections)+len(p.Omitted) != 4 {
				t.Fatal("unaccounted eligible entry")
			}
			if omissionCount(p.Handoff) != reportedOmissions(p) {
				t.Fatal("omission overhead or reporting mismatch")
			}
			ids := selectedIDs(p)
			for _, o := range p.Omitted {
				if has(ids, o.ID) {
					t.Fatal("omission simultaneously selected")
				}
				if o.Reason != ReasonBudget {
					t.Fatal("missing reason")
				}
			}
		}
	}
}

func TestEmptyRequestAndDeferredHistoryNeverClaimed(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	appendMsg(t, l, "m", "old", "user", "must survive zero room")
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	in := resume(b, fakeIdent(), "", "next", "")
	for _, budget := range []ByteBudget{-1, 0, 1} {
		in.Budget = budget
		if _, err := l.Plan(in); err == nil {
			t.Fatalf("empty JSON string needs 2 bytes, accepted %d", budget)
		}
	}
	in.Budget = 2
	p := mustPlan(t, l, in)
	if p.Payload != "" || p.PayloadBytes != 2 || !p.Empty() || len(p.Omitted) != 1 || p.Omitted[0].Reported {
		t.Fatalf("zero history room: %+v", p)
	}
	accept(t, l, s, p) // Success of a request-only turn is NOT history delivery.
	if len(get(t, s, b.ID).Coverage.Delivered) != 0 {
		t.Fatal("empty-budget success absorbed history")
	}
	in.Binding = get(t, s, b.ID)
	in.Budget = 4096
	if got := mustPlan(t, l, in); len(got.Selections) != 1 {
		t.Fatal("deferred history was discarded")
	}
}

func TestFullIgnoresCompleteAndPartialOldCoverage(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	e := appendMsg(t, l, "m", "old", "assistant", "abcdef")
	b := newBinding(t, s, "old", fakeIdent(), fakeEnv())
	for _, full := range []bool{false, true} {
		b.Coverage = NewCoverage()
		if full {
			b.Coverage.Delivered[e.ID] = RevisionDigest{Rev: 1, Digest: TextDigest(e.Text)}
		} else {
			b.Coverage.Partial[e.ID] = PartialCoverage{Rev: 1, Digest: TextDigest(e.Text), Ranges: []ByteRange{{0, 3}}}
		}
		in := newSession(fakeIdent(), "new request", "next", "")
		in.Binding = b
		p := mustPlan(t, l, in)
		if len(p.Selections) != 1 || len(p.Selections[0].Ranges) != 1 || p.Selections[0].Ranges[0] != (ByteRange{0, 6}) {
			t.Fatal("new native inherited old coverage")
		}
		if !strings.Contains(p.Handoff, "abcdef") || p.NativeSessionID != "" {
			t.Fatal("fallback not full")
		}
	}
}

func TestCurrentIdentityValidationAndHistoryCut(t *testing.T) {
	l := NewLedger()
	appendMsg(t, l, "old", "t0", "user", "same text") // identical text, DIFFERENT logical entry: keep it
	cur := appendMsg(t, l, "current", "t1", "user", "same text")
	appendMsg(t, l, "later", "t1", "assistant", "future answer")
	in := newSession(fakeIdent(), cur.Text, cur.TurnID, cur.ID)
	in.RequestInLedger = true
	in.HistoryBeforeOrder = cur.Order // Explicit branch/rewind, not an implicit retry cutoff.
	p := mustPlan(t, l, in)
	if ids := selectedIDs(p); len(ids) != 1 || ids[0] != "old" {
		t.Fatalf("current identity or future cutoff wrong: %v", ids)
	}
	for _, mut := range []func(*PlanInput){
		func(in *PlanInput) { in.RequestText = "different" },
		func(in *PlanInput) { in.CurrentEntryID = "missing" },
		func(in *PlanInput) { in.CurrentTurnID = "wrong" },
		func(in *PlanInput) { in.CurrentEntryID = "later" },
	} {
		bad := in
		mut(&bad)
		if _, err := l.Plan(bad); err == nil {
			t.Fatal("mismatched current entry accepted")
		}
	}
	appendMsg(t, l, "other-user", "t1", "user", "ambiguous")
	in.CurrentEntryID = ""
	if _, err := l.Plan(in); err == nil {
		t.Fatal("ambiguous current turn guessed")
	}
}

func TestStoredCurrentAttachmentsCannotBeSilentlyDropped(t *testing.T) {
	l := NewLedger()
	e := appendMsg(t, l, "image", "t1", "user", "see image", "asset:fake")
	in := newSession(fakeIdent(), e.Text, e.TurnID, e.ID)
	// The caller forgetting Attachments does not make a stored image disappear.
	if _, err := l.Plan(in); err == nil {
		t.Fatal("stored attachment silently discarded")
	}
}

func TestHistoryCutoffCannotPretendExistingNativeWasRewound(t *testing.T) {
	l, s := NewLedger(), NewBindingStore()
	e := appendMsg(t, l, "m", "old", "user", "old text")
	b := newBinding(t, s, "b", fakeIdent(), fakeEnv())
	in := resume(b, fakeIdent(), "new request", "new", "")
	in.HistoryBeforeOrder = e.Order
	if _, err := l.Plan(in); err == nil {
		t.Fatal("cutoff silently treated resumed native as rewound")
	}
}

func TestRequestBudgetAllowsLargeRequestWhileKeepingHandoffBounded(t *testing.T) {
	l := NewLedger()
	appendMsg(t, l, "old_1", "t0", "user", strings.Repeat("h", 4000))
	appendMsg(t, l, "old_2", "t0", "assistant", strings.Repeat("a", 4000))

	reqText := strings.Repeat("r", 125000)
	in := newSession(fakeIdent(), reqText, "t1", "")
	in.Budget = DefaultHandoffBudget
	in.RequestBudget = DefaultStreamRequestBudget

	p := mustPlan(t, l, in)
	if p.RequestBody != reqText || p.Payload != reqText {
		t.Fatalf("large request within RequestBudget must pass untouched without stuffing over-budget handoff")
	}
	if len(p.Selections) != 0 || len(p.Omitted) != 2 {
		t.Fatalf("expected all history omitted due to handoff budget, got selections=%d omitted=%d", len(p.Selections), len(p.Omitted))
	}
	for _, o := range p.Omitted {
		if o.Reason != ReasonBudget {
			t.Fatalf("expected ReasonBudget omission, got %+v", o)
		}
	}

	// Exceeding RequestBudget still rejects before execution with ErrBudget reporting RequestBudget.
	tooBig := newSession(fakeIdent(), strings.Repeat("x", int(DefaultStreamRequestBudget)), "t2", "")
	tooBig.Budget = DefaultHandoffBudget
	tooBig.RequestBudget = DefaultStreamRequestBudget
	_, err := l.Plan(tooBig)
	var over *ErrBudget
	if !errors.As(err, &over) || over.Limit != int(DefaultStreamRequestBudget) {
		t.Fatalf("expected ErrBudget with limit %d, got %v", DefaultStreamRequestBudget, err)
	}
}
