package shellhandlers_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
)

type ingressFake struct {
	mu             sync.Mutex
	name           string
	calls          []cr.RuntimeRequest
	emits          []func(cr.Event) error
	hold           bool
	recoverEntered chan struct{}
}

func (f *ingressFake) Capabilities() cr.Capabilities {
	return cr.Capabilities{Resume: true, Cancel: true, Approval: true, PermissionModes: []string{"ask"}, Budget: 8192}
}
func (f *ingressFake) Recover(ctx context.Context, r cr.RecoveryRequest) cr.RecoveryResult {
	if f.recoverEntered != nil {
		close(f.recoverEntered)
		<-ctx.Done()
		return cr.RecoveryResult{Kind: cr.RecoveryUnknown}
	}
	if r.Previous.ID != "" {
		return cr.RecoveryResult{Kind: cr.RecoveryResumed, NativeSessionID: r.Previous.NativeSessionID}
	}
	return cr.RecoveryResult{Kind: cr.RecoveryNew, NativeSessionID: f.name + "_" + r.Token.AttemptID}
}
func (f *ingressFake) Start(_ context.Context, r cr.RuntimeRequest, emit func(cr.Event) error) cr.SubmitResult {
	f.mu.Lock()
	f.calls = append(f.calls, r)
	f.emits = append(f.emits, emit)
	hold := f.hold
	f.mu.Unlock()
	if !hold {
		e := cr.Event{Token: r.Token, NativeSessionID: r.NativeSessionID, Kind: cr.EventDelivered, Delivery: cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}}
		if err := emit(e); err != nil {
			return cr.SubmitResult{Kind: cr.SubmitUnknown, Detail: err.Error()}
		}
		e.Kind = cr.EventText
		e.Text = "reply " + f.name
		_ = emit(e)
		e.Kind = cr.EventCompleted
		e.Work = cr.Activity{Known: true}
		_ = emit(e)
	}
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}
func (f *ingressFake) Cancel(context.Context, cr.AttemptToken) cr.CancelResult {
	return cr.CancelResult{Kind: cr.CancelStopped, Work: cr.Activity{Known: true}}
}
func (f *ingressFake) Approve(context.Context, cr.ApprovalDecision) error { return nil }
func (f *ingressFake) target(string) (cr.Target, error) {
	return cr.Target{Runtime: f, Identity: cr.NativeIdentity{DriverID: f.name, Transport: "fake", DriverVersion: "1", ResumeProtocol: "fake", Executable: "/fake/" + f.name, Source: "local", AccountID: "test-account", ConfigDir: "/fake/config", Cwd: "/fake/project", ConfigGen: 1}, Env: cr.CompatibilityKey{Model: "fake", PermissionMode: "ask"}}, nil
}
func (f *ingressFake) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }
func (f *ingressFake) call(i int) cr.RuntimeRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[i]
}
func fixtureIngress(t *testing.T, dir string) (*convstore.Store, *mainchat.Registry, *convSession) {
	t.Helper()
	s := convstore.New(dir)
	r := contract.NewRouter()
	managed := shellhandlers.InstallConversationRuntime(r, s)
	shellhandlers.InstallConversations(r, s, managed)
	ch := make(chan contract.ServerFrame, 1024)
	session := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	session.Handle([]byte(`{"t":"sub","event":"conversations.runtimeChanged"}`))
	t.Cleanup(func() { managed.Close(); session.Close() })
	return s, managed, &convSession{t: t, s: session, ch: ch}
}
func requireOK(t *testing.T, f contract.ServerFrame) any {
	t.Helper()
	if f.T != "res" {
		t.Fatalf("IPC rejected: %+v", f)
	}
	return f.Output
}
func generation(t *testing.T, c *convSession) uint64 {
	t.Helper()
	b, _ := json.Marshal(requireOK(t, c.call("conversations.runtimeState", `{"id":"c"}`)))
	var s struct{ Generation uint64 }
	_ = json.Unmarshal(b, &s)
	return s.Generation
}
func sendIngress(t *testing.T, c *convSession, id string) contract.ServerFrame {
	t.Helper()
	g := generation(t, c)
	return c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":%q,"turnId":%q,"text":%q,"expectedGeneration":%d}`, id, "t_"+id, "request "+id, g))
}
func seedIngress(t *testing.T, c *convSession) {
	requireOK(t, c.call("conversations.put", `{"meta":{"id":"c","backend":"nomi","name":"same sidebar"},"messages":[{"id":"seed","role":"user","content":"retained API history","timestamp":1}]}`))
}

func TestManagedActualIPCClaudeCodexClaudeAndRestart(t *testing.T) {
	dir := t.TempDir()
	s, r, c := fixtureIngress(t, dir)
	a, b := &ingressFake{name: "claude"}, &ingressFake{name: "codex"}
	r.Register("claude", a.target)
	r.Register("codex", b.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"codex"}`))
	requireOK(t, sendIngress(t, c, "two"))
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`))
	requireOK(t, sendIngress(t, c, "three"))
	first, last := a.call(0), a.call(1)
	other := b.call(0)
	if first.Plan.Strategy != cr.StrategyNewSession || other.Plan.Strategy != cr.StrategyNewSession || last.Plan.Strategy != cr.StrategyDelta || len(last.Plan.Selections) != 2 || last.NativeSessionID != first.NativeSessionID || strings.Count(last.Plan.Payload, "request three") != 1 {
		t.Fatal("real ingress lost resume/full/delta/current-request semantics")
	}
	messages, err := s.Messages("c", 0)
	if err != nil || len(messages) != 7 {
		t.Fatalf("authoritative transcript: %d %v", len(messages), err)
	}
	for _, field := range []string{"account", "cwd", "configuration"} {
		r.Register("claude", func(id string) (cr.Target, error) {
			target, err := a.target(id)
			switch field {
			case "account":
				target.Identity.AccountID = "changed"
			case "cwd":
				target.Identity.Cwd = "/different"
			case "configuration":
				target.Identity.ConfigGen++
			}
			return target, err
		})
		if got := sendIngress(t, c, "must-not-run-"+field); got.T != "err" || a.count() != 2 {
			t.Fatalf("incompatible %s reused native binding", field)
		}
	}
	if f := c.call("conversations.append", `{"id":"c","messages":[{"id":"duplicate"}]}`); f.T != "err" || f.Error.Code != "CONVERSATION_MANAGED" {
		t.Fatal("view became a second writer")
	}
	r.Close()
	_, next, view := fixtureIngress(t, dir)
	next.Register("claude", a.target)
	requireOK(t, view.call("conversations.runtimeState", `{"id":"c"}`))
	if a.count() != 2 || b.count() != 1 {
		t.Fatal("restart replayed a turn")
	}
	result := requireOK(t, view.call("conversations.messages", `{"id":"c"}`))
	encoded, _ := json.Marshal(result)
	var projection struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(encoded, &projection); err != nil || len(projection.Messages) != len(messages) {
		t.Fatalf("reload: %s", encoded)
	}
	for i := range messages {
		if string(projection.Messages[i]) != string(messages[i]) {
			t.Fatalf("reloaded message %d differs", i)
		}
	}
	state := requireOK(t, view.call("conversations.state", `{}`))
	data, _ := json.Marshal(state)
	var reloaded struct {
		Conversations []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"conversations"`
		Managed []string `json:"managed"`
	}
	if err := json.Unmarshal(data, &reloaded); err != nil || len(reloaded.Conversations) != 1 || len(reloaded.Managed) != 1 || reloaded.Managed[0] != "c" || reloaded.Conversations[0].ID != "c" || reloaded.Conversations[0].Name != "same sidebar" {
		t.Fatalf("sidebar identity changed: %s", data)
	}
}

func TestManagedIPCAdmissionApprovalCancelAndLateEvents(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f := &ingressFake{name: "claude", hold: true}
	r.Register("claude", f.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	request := f.call(0)
	if got := sendIngress(t, c, "two"); got.T != "err" || f.count() != 1 {
		t.Fatal("busy actor executed concurrently")
	}
	if got := c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`); got.T != "err" {
		t.Fatal("running switch accepted")
	}
	f.mu.Lock()
	emit := f.emits[0]
	f.mu.Unlock()
	e := cr.Event{Token: request.Token, NativeSessionID: request.NativeSessionID, Kind: cr.EventApproval, ApprovalID: "p"}
	if err := emit(e); err != nil {
		t.Fatal(err)
	}
	requireOK(t, c.call("conversations.runtimeApprove", fmt.Sprintf(`{"id":"c","token":{"conversationId":"c","attemptId":%q,"generation":%d},"approvalId":"p","allow":false}`, request.Token.AttemptID, request.Token.Generation)))
	if got := c.call("conversations.delete", `{"id":"c"}`); got.T != "err" {
		t.Fatal("deleted active work")
	}
	requireOK(t, c.call("conversations.runtimeCancel", `{"id":"c"}`))
	before, _ := s.ReadManaged("c")
	e.Kind = cr.EventDelivered
	e.Delivery = cr.Delivery{PlanID: request.Plan.ID, NativeSessionID: request.NativeSessionID, Kind: cr.DeliveredFull}
	if err := emit(e); err == nil {
		t.Fatal("canceled ACK accepted")
	}
	after, _ := s.ReadManaged("c")
	if before.Checksum != after.Checksum {
		t.Fatal("late event mutated disk through observer")
	}
	requireOK(t, c.call("conversations.delete", `{"id":"c"}`))
	state, err := s.State()
	if err != nil || len(state.Conversations) != 0 {
		t.Fatal("delete failed to remove authoritative projection")
	}
	if _, err = s.Messages("c", 0); err != convstore.ErrNotFound {
		t.Fatal("deleted history resurrected")
	}
	if got := c.call("conversations.put", `{"meta":{"id":"c"}}`); got.T != "err" {
		t.Fatal("legacy put resurrected tombstone")
	}
}

func TestManagedIPCShutdownDuringRecoveryIsBoundedAndRestartUncertain(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	f := &ingressFake{name: "claude", recoverEntered: make(chan struct{})}
	r.Register("claude", f.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	done := make(chan struct{})
	go func() { _ = sendIngress(t, c, "one"); close(done) }()
	select {
	case <-f.recoverEntered:
	case <-time.After(time.Second):
		t.Fatal("no recovery")
	}
	closed := make(chan struct{})
	go func() { r.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("shutdown deadlocked")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("send did not unwind")
	}
	_, _, next := fixtureIngress(t, dir)
	result := requireOK(t, next.call("conversations.runtimeState", `{"id":"c"}`))
	b, _ := json.Marshal(result)
	if !strings.Contains(string(b), `"phase":"uncertain"`) || f.count() != 0 {
		t.Fatal("restart replayed interrupted preparation")
	}
}

func TestManagedIPCStopBeforeAdmissionFencesLateSend(t *testing.T) {
	_, r, c := fixtureIngress(t, t.TempDir())
	f := &ingressFake{name: "claude"}
	r.Register("claude", f.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	g := generation(t, c)
	requireOK(t, c.call("conversations.runtimeCancel", fmt.Sprintf(`{"id":"c","turnId":"late","beforeGeneration":%d}`, g)))
	got := c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"late","turnId":"late","text":"must not run","expectedGeneration":%d}`, g))
	if got.T != "err" || f.count() != 0 {
		t.Fatal("late IPC executed after confirmed stop")
	}
}

func TestManagedIPCActuallyConcurrentSendsAdmitOnce(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f := &ingressFake{name: "claude", hold: true}
	r.Register("claude", f.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	g := generation(t, c)
	leftCh := c.registerWaiter("left")
	rightCh := c.registerWaiter("right")
	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, id := range []string{"left", "right"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			<-start
			c.s.Handle([]byte(fmt.Sprintf(`{"t":"req","id":%q,"kind":"call","name":"conversations.runtimeSend","input":{"id":"c","messageId":%q,"turnId":%q,"text":"once","expectedGeneration":%d}}`, id, id, id, g)))
		}(id)
	}
	close(start)
	wg.Wait()
	successes, failures := 0, 0
	timeout := time.After(5 * time.Second)
	for _, ch := range []chan contract.ServerFrame{leftCh, rightCh} {
		select {
		case frame := <-ch:
			if frame.T == "res" {
				successes++
			} else if frame.T == "err" {
				failures++
			}
		case <-timeout:
			t.Fatal("concurrent IPC responses lost")
		}
	}
	messages, err := s.Messages("c", 0)
	if successes != 1 || failures != 1 || f.count() != 1 || err != nil || len(messages) != 2 {
		t.Fatalf("double admission: success=%d failure=%d starts=%d messages=%d err=%v", successes, failures, f.count(), len(messages), err)
	}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	requireOK(t, c.call("conversations.runtimeState", `{"id":"c"}`))
	state, _ := r.State("c")
	if state.Phase != cr.PhaseUncertain {
		t.Fatalf("release reopened executable: %+v", state)
	}
}

func TestManagedIPCUnavailableOrUnconfirmedNeverAdoptsLegacy(t *testing.T) {
	s := convstore.New(t.TempDir())
	router := contract.NewRouter()
	managed := shellhandlers.InstallConversationRuntime(router, s)
	shellhandlers.InstallConversations(router, s, managed)
	ch := make(chan contract.ServerFrame, 32)
	session := router.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer session.Close()
	defer managed.Close()
	c := &convSession{t: t, s: session, ch: ch}
	seedIngress(t, c)
	f := &ingressFake{name: "claude"}
	managed.Register("claude", f.target)
	for _, input := range []string{`{"id":"c","backend":"missing","confirm":true}`, `{"id":"c","backend":"claude","confirm":false}`} {
		if got := c.call("conversations.runtimeAdopt", input); got.T != "err" {
			t.Fatalf("unsafe adoption: %+v", got)
		}
	}
	if s.IsManaged("c") || f.count() != 0 {
		t.Fatal("capability probe migrated or ran legacy chat")
	}
	requireOK(t, c.call("conversations.append", `{"id":"c","messages":[{"id":"old-api","role":"assistant","content":"old API still writable"}]}`))
	messages, err := s.Messages("c", 0)
	if err != nil || len(messages) != 2 {
		t.Fatalf("legacy API unavailable: %v", err)
	}
}

func TestManagedIPCLeaseReleaseRacesAdmissionWithoutReplaying(t *testing.T) {
	for i := 0; i < 12; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			s, r, c := fixtureIngress(t, t.TempDir())
			f := &ingressFake{name: "claude", hold: true}
			r.Register("claude", f.target)
			seedIngress(t, c)
			requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
			g := generation(t, c)
			other := mainchat.New(s, nil)
			defer other.Close()
			if _, err := other.State("c"); err == nil {
				t.Fatal("two application owners acquired the same lease")
			}
			send := fmt.Sprintf(`{"t":"req","kind":"call","name":"conversations.runtimeSend","id":"send","input":{"id":"c","messageId":"m","turnId":"t","text":"once","expectedGeneration":%d}}`, g)
			release := `{"t":"req","kind":"call","name":"conversations.runtimeRelease","id":"release","input":{"id":"c"}}`
			sendCh := c.registerWaiter("send")
			releaseCh := c.registerWaiter("release")
			var wg sync.WaitGroup
			start := make(chan struct{})
			for _, frame := range []string{send, release} {
				wg.Add(1)
				go func(frame string) { defer wg.Done(); <-start; c.s.Handle([]byte(frame)) }(frame)
			}
			close(start)
			wg.Wait()
			received := map[string]bool{}
			timeout := time.After(5 * time.Second)
			for _, entry := range []struct {
				id string
				ch chan contract.ServerFrame
			}{{"send", sendCh}, {"release", releaseCh}} {
				select {
				case frame := <-entry.ch:
					if frame.ID == entry.id {
						received[entry.id] = true
					}
				case <-timeout:
					t.Fatal("release/admission deadlock")
				}
			}
			state, err := r.State("c")
			if err != nil || f.count() > 1 {
				t.Fatalf("lease race: %v starts=%d", err, f.count())
			}
			if f.count() == 1 && state.Phase != cr.PhaseUncertain {
				t.Fatalf("released live execution was treated as safe to retry: %+v", state)
			}
		})
	}
}
func TestManagedIPCDeletingMultipleChatsKeepsOtherProjectionIdentities(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f := &ingressFake{name: "claude"}
	r.Register("claude", f.target)
	for _, id := range []string{"a", "b", "c", "d"} {
		requireOK(t, c.call("conversations.put", fmt.Sprintf(`{"meta":{"id":%q,"backend":"nomi","name":%q},"messages":[{"id":"seed","role":"user","content":%q,"timestamp":1}]}`, id, id, id)))
		requireOK(t, c.call("conversations.runtimeAdopt", fmt.Sprintf(`{"id":%q,"backend":"claude","confirm":true}`, id)))
	}
	requireOK(t, c.call("conversations.setPointers", `{"current":"c","lastNomi":"c"}`))
	for _, id := range []string{"a", "c"} {
		requireOK(t, c.call("conversations.delete", fmt.Sprintf(`{"id":%q}`, id)))
	}
	state, err := s.State()
	if err != nil || len(state.Conversations) != 2 || len(state.Managed) != 2 || len(state.Counts) != 2 || state.Current != "" || state.LastNomi != "" {
		t.Fatalf("tombstone overlay corrupt: %+v %v", state, err)
	}
	for _, raw := range state.Conversations {
		var meta map[string]any
		_ = json.Unmarshal(raw, &meta)
		id := meta["id"].(string)
		if id != "b" && id != "d" {
			t.Fatalf("deleted/wrong identity: %s", raw)
		}
		messages, err := s.Messages(id, 0)
		if err != nil || len(messages) != 1 || !strings.Contains(string(messages[0]), fmt.Sprintf(`"content":%q`, id)) {
			t.Fatalf("projection shifted: %s %+v %v", id, messages, err)
		}
	}
}

type switchAwareIngressFake struct {
	*ingressFake
	prepareErr error
	prepCalls  int
}

func (f *switchAwareIngressFake) PrepareSwitch(context.Context) error {
	f.mu.Lock()
	f.prepCalls++
	err := f.prepareErr
	f.mu.Unlock()
	return err
}

func (f *switchAwareIngressFake) Teardown(context.Context) error { return nil }

func TestManagedIPCSwitchTransactionAndRollbackAfterFailureOrRestart(t *testing.T) {
	dir := t.TempDir()
	s, r, c := fixtureIngress(t, dir)
	claude := &switchAwareIngressFake{ingressFake: &ingressFake{name: "claude"}}
	codex := &switchAwareIngressFake{ingressFake: &ingressFake{name: "codex"}}
	r.Register("claude", func(string) (cr.Target, error) {
		tgt, err := claude.target("")
		tgt.Runtime = claude
		return tgt, err
	})
	r.Register("codex", func(string) (cr.Target, error) {
		tgt, err := codex.target("")
		tgt.Runtime = codex
		return tgt, err
	})
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	msgsBefore, _ := s.Messages("c", 0)

	g := generation(t, c)
	out := requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"codex","confirm":true,"expectedGeneration":%d}`, g)))
	b, _ := json.Marshal(out)
	var sw struct {
		Backend    string
		Generation uint64
		LastSwitch struct {
			FromBackend      string `json:"fromBackend"`
			ToBackend        string `json:"toBackend"`
			ExpectedStrategy string `json:"expectedStrategy"`
			PlannedEntries   int    `json:"plannedEntries"`
			ResumableBinding string `json:"resumableBinding"`
		} `json:"lastSwitch"`
	}
	_ = json.Unmarshal(b, &sw)
	if sw.Backend != "codex" || sw.LastSwitch.FromBackend != "claude" || sw.LastSwitch.ToBackend != "codex" || sw.LastSwitch.ExpectedStrategy != "new_session" || sw.LastSwitch.PlannedEntries != 3 || codex.prepCalls != 1 {
		t.Fatalf("unexpected IPC switch view: %s", b)
	}
	msgsAfterSwitch, _ := s.Messages("c", 0)
	if len(msgsAfterSwitch) != len(msgsBefore) {
		t.Fatalf("switch dispatched unwanted turn messages: %d -> %d", len(msgsBefore), len(msgsAfterSwitch))
	}

	// Send once on Codex, then switch back to Claude and confirm delta preview + real delta send.
	requireOK(t, sendIngress(t, c, "two"))
	g = generation(t, c)
	outBack := requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"claude","confirm":true,"expectedGeneration":%d}`, g)))
	b, _ = json.Marshal(outBack)
	sw = struct {
		Backend    string
		Generation uint64
		LastSwitch struct {
			FromBackend      string `json:"fromBackend"`
			ToBackend        string `json:"toBackend"`
			ExpectedStrategy string `json:"expectedStrategy"`
			PlannedEntries   int    `json:"plannedEntries"`
			ResumableBinding string `json:"resumableBinding"`
		} `json:"lastSwitch"`
	}{}
	_ = json.Unmarshal(b, &sw)
	if sw.Backend != "claude" || sw.LastSwitch.ExpectedStrategy != "delta" || sw.LastSwitch.ResumableBinding == "" || sw.LastSwitch.PlannedEntries != 2 {
		t.Fatalf("switch back failed delta preview: %s", b)
	}
	requireOK(t, sendIngress(t, c, "three"))
	if last := claude.call(1); last.Plan.Strategy != cr.StrategyDelta || len(last.Plan.Selections) != 2 {
		t.Fatalf("post-switch IPC send did not use delta: %+v", last.Plan)
	}

	// Target preparation failure rolls back to Claude cleanly.
	codex.mu.Lock()
	codex.prepareErr = errors.New("codex prepare failed")
	codex.mu.Unlock()
	g = generation(t, c)
	failRes := c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"codex","confirm":true,"expectedGeneration":%d}`, g))
	if failRes.T != "err" {
		t.Fatalf("expected error on PrepareSwitch failure: %+v", failRes)
	}
	stateAfterFail, err := r.State("c")
	if err != nil || stateAfterFail.Backend != "claude" || stateAfterFail.PendingSwitch != nil || stateAfterFail.Generation <= g {
		t.Fatalf("failed IPC switch did not roll back cleanly: %+v err=%v", stateAfterFail, err)
	}

	// Simulate an interrupted switch persisted on disk across restart, then roll back via IPC.
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	lease, err := s.OpenManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := lease.Session()
	if err != nil {
		t.Fatal(err)
	}
	cp := sess.Checkpoint()
	cp.PendingSwitch = &cr.SwitchState{
		Phase: "handoff",
		From:  cp.Selected,
		To:    cr.TargetState{Identity: cr.NativeIdentity{DriverID: "codex", Transport: "fake", DriverVersion: "1", ResumeProtocol: "fake", Executable: "/fake/codex", Source: "local", AccountID: "test-account", ConfigDir: "/fake/config", Cwd: "/fake/project", ConfigGen: 1}, Env: cr.CompatibilityKey{Model: "fake", PermissionMode: "ask"}, Capabilities: cp.Selected.Capabilities},
	}
	if err := lease.Commit(cp); err != nil {
		t.Fatal(err)
	}
	_ = lease.Close()

	_, r2, c2 := func() (*convstore.Store, *mainchat.Registry, *convSession) {
		router2 := contract.NewRouter()
		managed2 := shellhandlers.InstallConversationRuntime(router2, s)
		shellhandlers.InstallConversations(router2, s, managed2)
		ch2 := make(chan contract.ServerFrame, 1024)
		sess2 := router2.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch2 <- f })
		t.Cleanup(func() { managed2.Close(); sess2.Close() })
		return s, managed2, &convSession{t: t, s: sess2, ch: ch2}
	}()
	_ = r2
	stView := requireOK(t, c2.call("conversations.runtimeState", `{"id":"c"}`))
	b, _ = json.Marshal(stView)
	var recovered struct {
		Backend       string
		Generation    uint64
		Phase         string
		PendingSwitch *struct{ Phase string } `json:"pendingSwitch"`
	}
	_ = json.Unmarshal(b, &recovered)
	if recovered.Phase != "uncertain" || recovered.PendingSwitch == nil || recovered.PendingSwitch.Phase != "handoff" {
		t.Fatalf("restarted interrupted switch did not surface pendingSwitch in uncertain state: %s", b)
	}
	resolved := requireOK(t, c2.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"rollback-switch","confirm":true,"expectedGeneration":%d}`, recovered.Generation)))
	b, _ = json.Marshal(resolved)
	var afterResolve struct {
		Backend       string
		Phase         string
		PendingSwitch any `json:"pendingSwitch"`
	}
	_ = json.Unmarshal(b, &afterResolve)
	if afterResolve.Phase != "idle" || afterResolve.Backend != "claude" || afterResolve.PendingSwitch != nil {
		t.Fatalf("rollback-switch IPC resolve failed: %s", b)
	}
}

func TestManagedIPCParityMetadataAbandonImagesAndConfig(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	apiFake := &ingressFake{name: "api"}
	r.Register("api", func(id string) (cr.Target, error) {
		tgt, err := apiFake.target(id)
		cfg := r.ConfigFor(id, "api")
		if cfg.Model != "" {
			tgt.Env.Model = cfg.Model
		}
		if cfg.Effort != "" {
			tgt.Effort = cfg.Effort
		}
		tgt.Runtime = &parityFake{ingressFake: apiFake, bridges: &cr.CapabilityBridges{
			Computer:    cr.BridgeState{Status: "native"},
			MCP:         cr.BridgeState{Status: "native"},
			Persona:     cr.BridgeState{Status: "native"},
			Memory:      cr.BridgeState{Status: "native"},
			Knowledge:   cr.BridgeState{Status: "native"},
			Skills:      cr.BridgeState{Status: "native"},
			Attachments: cr.BridgeState{Status: "bridged"},
		}}
		return tgt, err
	})
	claudeFake := &ingressFake{name: "claude"}
	r.Register("claude", claudeFake.target)

	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))

	// Attachments rejected cleanly when active backend lacks attachment bridge.
	g := generation(t, c)
	badImg := c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"img-bad","turnId":"t-bad","text":"look","images":["data:image/png;base64,AAA"],"expectedGeneration":%d}`, g))
	if badImg.T != "err" || claudeFake.count() != 0 {
		t.Fatalf("unsupported image request was not rejected before runtime: %+v", badImg)
	}

	// Switch to API with explicit model + effort, and verify metadata, images, failure -> abandon.
	g = generation(t, c)
	swOut := requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"api","model":"gpt-5","effort":"high","confirm":true,"expectedGeneration":%d}`, g)))
	b, _ := json.Marshal(swOut)
	var swState struct {
		Backend    string
		Generation uint64
		Model      string
		Effort     string
		Capabilities struct {
			Attachments bool
			Bridges     *cr.CapabilityBridges
		}
	}
	_ = json.Unmarshal(b, &swState)
	if swState.Backend != "api" || swState.Model != "gpt-5" || swState.Effort != "high" || !swState.Capabilities.Attachments || swState.Capabilities.Bridges == nil || swState.Capabilities.Bridges.Attachments.Status != "bridged" {
		t.Fatalf("switched state missing parity metadata: %s", b)
	}

	// Send fails after submit -> exposes failedRequest -> abandon clears to idle.
	apiFake.hold = true
	requireOK(t, c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"img-ok","turnId":"t-ok","text":"see","images":["data:image/png;base64,BBB"],"expectedGeneration":%d}`, swState.Generation)))
	if len(apiFake.call(0).Images) != 1 || apiFake.call(0).Images[0] != "data:image/png;base64,BBB" {
		t.Fatalf("wired image lost before adapter: %+v", apiFake.call(0).Images)
	}
	tok := cr.AttemptToken{ConversationID: "c", AttemptID: fmt.Sprintf("a%d", swState.Generation+1), Generation: swState.Generation + 1}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	_ = tok

	// Re-open runtime and verify phase=uncertain, then resolve via decision="abandon".
	stRaw := requireOK(t, c.call("conversations.runtimeState", `{"id":"c"}`))
	b, _ = json.Marshal(stRaw)
	var unc struct {
		Phase      string
		Generation uint64
	}
	_ = json.Unmarshal(b, &unc)
	if unc.Phase != "uncertain" {
		t.Fatalf("expected uncertain after release during active send: %s", b)
	}
	abandoned := requireOK(t, c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"abandon","confirm":true,"expectedGeneration":%d}`, unc.Generation)))
	b, _ = json.Marshal(abandoned)
	var afterAbandon struct {
		Phase string
	}
	_ = json.Unmarshal(b, &afterAbandon)
	if afterAbandon.Phase != "idle" {
		t.Fatalf("abandon resolve failed: %s", b)
	}
}

type parityFake struct {
	*ingressFake
	bridges *cr.CapabilityBridges
}

func (p *parityFake) Capabilities() cr.Capabilities {
	caps := p.ingressFake.Capabilities()
	caps.Attachments = true
	caps.Bridges = p.bridges
	return caps
}
