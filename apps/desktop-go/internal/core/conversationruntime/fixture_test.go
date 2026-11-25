package conversationruntime

import (
	"encoding/json"
	"strings"
	"testing"
)

// fakeIdent is an explicit, entirely synthetic launch identity.
func fakeIdent(mut ...func(*NativeIdentity)) NativeIdentity {
	id := NativeIdentity{
		DriverID: "claude", Transport: "stream-json-stdin", DriverVersion: "2.0.1",
		ResumeProtocol: "argv-resume", Executable: "/opt/fake/bin/claude",
		ExecutableSize: 1234, ExecutableMtimeMS: 1700000000, Source: "local", AccountID: "acct_fake",
		ConfigDir: "/home/fake/.claude", ConfigGen: 7, Cwd: "/work/project",
		LaunchFingerprint: "lf_fake",
	}
	for _, m := range mut {
		m(&id)
	}
	return id
}

func fakeEnv() CompatibilityKey {
	return CompatibilityKey{Model: "claude-fake", Effort: "low", PermissionMode: "ask"}
}

func wrapper() HandoffWrapper {
	return HandoffWrapper{Prefix: "<handoff>\n", Suffix: "\n</handoff>\n---\n"}
}

func appendMsg(t *testing.T, l *Ledger, id, turn, role, text string, att ...string) Entry {
	t.Helper()
	e, err := l.Append(Entry{ID: id, TurnID: turn, Role: role, Origin: "api", Text: text, Attachments: att})
	if err != nil {
		t.Fatalf("append %s: %v", id, err)
	}
	return e
}

// rec appends a user message and (if non-empty) its assistant reply.
func rec(t *testing.T, l *Ledger, turn, user, assistant string) {
	t.Helper()
	appendMsg(t, l, "u_"+turn, turn, "user", user)
	if assistant != "" {
		appendMsg(t, l, "a_"+turn, turn, "assistant", assistant)
	}
}

// newBinding creates an idle binding with a confirmed native session via the
// public store API.
func newBinding(t *testing.T, s *BindingStore, id string, ident NativeIdentity, env CompatibilityKey) Binding {
	t.Helper()
	b := Binding{ID: id, CompatKey: ident.Key(env), NativeSessionID: "native_" + id,
		Status: StatusIdle, Coverage: NewCoverage()}
	if err := s.Put(b); err != nil {
		t.Fatalf("put binding %s: %v", id, err)
	}
	return b
}

// get returns the stored binding, failing the test when it is absent.
func get(t *testing.T, s *BindingStore, id string) Binding {
	t.Helper()
	b, ok := s.Get(id)
	if !ok {
		t.Fatalf("binding %s missing", id)
	}
	return b
}

func basePlan(ident NativeIdentity, req, turn, entry string) PlanInput {
	return PlanInput{Identity: ident, Env: fakeEnv(), RequestText: req, CurrentTurnID: turn,
		CurrentEntryID: entry, Budget: 1 << 20, Wrapper: wrapper()}
}

// newSession is an explicit new target (no binding).
func newSession(ident NativeIdentity, req, turn, entry string) PlanInput {
	in := basePlan(ident, req, turn, entry)
	in.Target = TargetNew
	return in
}

// resume is a request on the given binding, continuing it explicitly.
func resume(b Binding, ident NativeIdentity, req, turn, entry string) PlanInput {
	in := basePlan(ident, req, turn, entry)
	in.Binding, in.Target = b, TargetCurrent
	return in
}

// continueBinding resolves the next turn through the public APIs, as a
// production caller must: resume the matching safe binding when it is exactly
// resumable, otherwise start a new session explicitly (never silently).
func continueBinding(t *testing.T, l *Ledger, s *BindingStore, ident NativeIdentity, env CompatibilityKey, req, turn, entry string) (Plan, Binding) {
	t.Helper()
	var candidates []Binding
	for _, b := range s.All() {
		if b.CompatKey == ident.Key(env) && b.Status.Safe() {
			candidates = append(candidates, b)
		}
	}
	if n := len(candidates); n > 1 {
		t.Fatalf("%d safe bindings share the compatibility key: identity/account must be part of it", n)
	}
	if len(candidates) == 1 {
		in := basePlan(ident, req, turn, entry)
		in.Env, in.Binding, in.Target = env, candidates[0], TargetCurrent
		p := mustPlan(t, l, in)
		if p.Strategy != StrategyBlocked {
			return p, candidates[0]
		}
	}
	in := basePlan(ident, req, turn, entry)
	in.Env, in.Target = env, TargetNew
	old := Binding{}
	if len(candidates) == 1 {
		old = candidates[0]
	}
	return mustPlan(t, l, in), old
}

func mustPlan(t *testing.T, l *Ledger, in PlanInput) Plan {
	t.Helper()
	p, err := l.Plan(in)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if p.Strategy == StrategyBlocked && p.Error == "" {
		t.Fatal("blocked plan must carry an actionable error")
	}
	assertPayload(t, p, in.Budget)
	return p
}

// assertPayload checks the planner invariant that matters most: the actual
// serialized Handoff never exceeds the budget, and the recorded sizes are the
// real json.Marshal sizes.
func assertPayload(t *testing.T, p Plan, budget ByteBudget) {
	t.Helper()
	if p.Strategy == StrategyBlocked {
		if p.Payload != "" || len(p.Selections) != 0 {
			t.Fatal("blocked plan has sendable content")
		}
		return
	}
	want := p.RequestBody
	if p.Handoff != "" {
		want = p.Handoff + "\n" + want
	}
	if p.Payload != want {
		t.Fatalf("payload assembly: got %q want %q", p.Payload, want)
	}
	b, err := json.Marshal(p.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > int(budget) || p.PayloadBytes != len(b) {
		t.Fatalf("actual payload %d, recorded %d, budget %d: %q", len(b), p.PayloadBytes, budget, p.Payload)
	}
}

func accept(t *testing.T, l *Ledger, s *BindingStore, p Plan) {
	t.Helper()
	if err := l.Commit(s, p, Delivery{PlanID: p.ID, Kind: DeliveredFull}); err != nil {
		t.Fatalf("commit %s: %v", p.ID, err)
	}
}

func selectedIDs(p Plan) []string {
	out := make([]string, 0, len(p.Selections))
	for _, s := range p.Selections {
		out = append(out, s.ID)
	}
	return out
}

func has(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func omissionReasons(p Plan) map[string]string {
	m := map[string]string{}
	for _, o := range p.Omitted {
		m[o.ID] = o.Reason
	}
	return m
}

func expectErrIs(t *testing.T, err, target error) {
	t.Helper()
	if target == nil {
		if err != nil {
			t.Fatalf("want no error, got %v", err)
		}
		return
	}
	if err == nil || !errorsIs(err, target) {
		t.Fatalf("want error %v, got %v", target, err)
	}
}

// errorsIs is a tiny errors.Is equivalent kept explicit in tests.
func errorsIs(err, target error) bool {
	for err != nil {
		if err == target {
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

// twoExchanges records two delivered exchanges in the ledger.
func twoExchanges(t *testing.T) *Ledger {
	t.Helper()
	l := NewLedger()
	rec(t, l, "t1", "explain the build", "the build runs go build")
	rec(t, l, "t2", "now fix the lint", "lint fixed in main.go")
	return l
}

// deliverOn commits one explicit new-session delta (request first) to binding
// id on ident so that both exchanges count as delivered natively.
func deliverOn(t *testing.T, l *Ledger, s *BindingStore, id string, ident NativeIdentity) {
	t.Helper()
	b := newBinding(t, s, id, ident, fakeEnv())
	p := mustPlan(t, l, resume(b, ident, "seed request", "", ""))
	if len(p.Selections) != 4 {
		t.Fatalf("seed delta wants all 4 entries, got %v", selectedIDs(p))
	}
	accept(t, l, s, p)
	if got := get(t, s, id); got.NativeSessionID != "native_"+id || len(got.Coverage.Delivered) != 4 {
		t.Fatalf("seed delivered = %v", got.Coverage.Delivered)
	}
}

// omissionCount counts "[omitted …]" markers in a handoff.
func omissionCount(h string) int { return strings.Count(h, "[omitted ") }

func reportedOmissions(p Plan) int {
	n := 0
	for _, o := range p.Omitted {
		if o.Reported {
			n++
		}
	}
	return n
}
func findOmission(p Plan, id string) Omission {
	for _, o := range p.Omitted {
		if o.ID == id {
			return o
		}
	}
	return Omission{}
}
