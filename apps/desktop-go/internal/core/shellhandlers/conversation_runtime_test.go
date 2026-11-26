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
		// The frame carries *ErrorPayload: print the rejected call and the
		// error's detail value (code/message/data), not a pointer.
		var detail any = f.Error
		if f.Error != nil {
			detail = *f.Error
		}
		t.Fatalf("IPC rejected: id=%s error=%+v", f.ID, detail)
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
		Backend      string
		Generation   uint64
		Model        string
		Effort       string
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

type titleModelFake struct {
	*ingressFake
	mu      sync.Mutex
	onTitle func(string)
	model   string
}

func (f *titleModelFake) SetTitleHandler(fn func(string)) {
	f.mu.Lock()
	f.onTitle = fn
	f.mu.Unlock()
}

func (f *titleModelFake) pushTitle(title string) {
	f.mu.Lock()
	fn := f.onTitle
	f.mu.Unlock()
	if fn != nil {
		fn(title)
	}
}

func (f *titleModelFake) Start(_ context.Context, r cr.RuntimeRequest, emit func(cr.Event) error) cr.SubmitResult {
	f.mu.Lock()
	f.ingressFake.mu.Lock()
	f.calls = append(f.calls, r)
	f.emits = append(f.emits, emit)
	model := f.model
	f.ingressFake.mu.Unlock()
	f.mu.Unlock()
	go func() {
		e := cr.Event{Token: r.Token, NativeSessionID: r.NativeSessionID, Kind: cr.EventDelivered, Delivery: cr.Delivery{PlanID: r.Plan.ID, NativeSessionID: r.NativeSessionID, Kind: cr.DeliveredFull}}
		if emit(e) != nil {
			return
		}
		e.Kind = cr.EventText
		e.Text = "reply from " + f.name
		_ = emit(e)
		e.Kind = cr.EventCompleted
		e.Work = cr.Activity{Known: true}
		e.Model = model
		_ = emit(e)
	}()
	return cr.SubmitResult{Kind: cr.SubmitAccepted}
}

func TestManagedTitleLifecycleModelAndMetaPatch(t *testing.T) {
	dir := t.TempDir()
	s, r, c := fixtureIngress(t, dir)
	tf := &titleModelFake{ingressFake: &ingressFake{name: "antigravity"}, model: "gemini-4-neon-medium"}
	r.Register("antigravity", func(id string) (cr.Target, error) {
		tgt, err := tf.ingressFake.target(id)
		tgt.Runtime = tf
		return tgt, err
	})

	requireOK(t, c.call("conversations.put", `{"meta":{"id":"c","backend":"nomi","name":"新对话","createdAt":1000,"updatedAt":1000,"projectId":"p1"},"messages":[]}`))
	stRaw := requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"antigravity","permissionMode":"ask","confirm":true}`))
	stBytes, _ := json.Marshal(stRaw)
	var adopted struct {
		Backend        string
		PermissionMode string
		Generation     uint64
	}
	_ = json.Unmarshal(stBytes, &adopted)
	if adopted.Backend != "antigravity" || adopted.PermissionMode != "ask" {
		t.Fatalf("adopted state = %s", stBytes)
	}

	g := generation(t, c)
	requireOK(t, c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"m1","turnId":"t1","text":"帮我检查 ACP 流式输出   \n <attached-file name=\"a.txt\" path=\"/tmp/a.txt\" />","expectedGeneration":%d}`, g)))

	readMeta := func() map[string]any {
		t.Helper()
		raw := requireOK(t, c.call("conversations.state", `{}`))
		b, _ := json.Marshal(raw)
		var state struct {
			Conversations []map[string]any `json:"conversations"`
		}
		_ = json.Unmarshal(b, &state)
		for _, conv := range state.Conversations {
			if conv["id"] == "c" {
				return conv
			}
		}
		t.Fatalf("conversation c missing from state: %s", b)
		return nil
	}

	// Wait until turn completes and modelId + heuristic name + updatedAt are persisted.
	var meta map[string]any
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		meta = readMeta()
		if meta["modelId"] == "gemini-4-neon-medium" && meta["name"] == "帮我检查 ACP 流式输出" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if meta["name"] != "帮我检查 ACP 流式输出" || meta["modelId"] != "gemini-4-neon-medium" {
		t.Fatalf("after first turn meta = %v", meta)
	}
	updatedAfterTurn := meta["updatedAt"]

	// Native ACP title supersedes heuristic title.
	tf.pushTitle("Native ACP Session Title")
	meta = readMeta()
	if meta["name"] != "Native ACP Session Title" {
		t.Fatalf("expected native title to replace heuristic title, got %v", meta["name"])
	}

	// Blank rename rejected with BAD_INPUT.
	if bad := c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"   "}`); bad.T != "err" || bad.Error.Code != "BAD_INPUT" {
		t.Fatalf("expected BAD_INPUT on blank name, got %+v", bad)
	}

	// Manual user rename locks title against later native updates and preserves updatedAt.
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"Manual User Title"}`))
	meta = readMeta()
	if meta["name"] != "Manual User Title" {
		t.Fatalf("manual rename failed: %v", meta)
	}
	tf.pushTitle("Should Not Overwrite Manual")
	meta = readMeta()
	if meta["name"] != "Manual User Title" {
		t.Fatalf("native title overwrote manual rename: %v", meta["name"])
	}

	// Pin / unpin / archive / unarchive without bumping updatedAt.
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","pinnedAt":123456}`))
	meta = readMeta()
	if meta["pinnedAt"] != float64(123456) {
		t.Fatalf("pinnedAt missing: %v", meta)
	}
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","pinnedAt":null}`))
	meta = readMeta()
	if _, has := meta["pinnedAt"]; has {
		t.Fatalf("pinnedAt not cleared: %v", meta)
	}
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","archivedAt":654321}`))
	meta = readMeta()
	if meta["archivedAt"] != float64(654321) {
		t.Fatalf("archivedAt missing: %v", meta)
	}
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","archivedAt":null}`))
	meta = readMeta()
	if _, has := meta["archivedAt"]; has {
		t.Fatalf("archivedAt not cleared: %v", meta)
	}

	// Update and clear reasoningEffort / longContext on managed conversation without bumping updatedAt.
	if bad := c.call("conversations.runtimeUpdateMeta", `{"id":"c","reasoningEffort":"   "}`); bad.T != "err" || bad.Error.Code != "BAD_INPUT" {
		t.Fatalf("expected BAD_INPUT on blank reasoningEffort, got %+v", bad)
	}
	if bad := c.call("conversations.runtimeUpdateMeta", `{"id":"c","longContext":{"model":"p/m"}}`); bad.T != "err" || bad.Error.Code != "BAD_INPUT" {
		t.Fatalf("expected BAD_INPUT on missing longContext.on, got %+v", bad)
	}
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","reasoningEffort":"high","longContext":{"model":"maas/deepseek-v4.1-flash","on":true}}`))
	meta = readMeta()
	if meta["reasoningEffort"] != "high" {
		t.Fatalf("reasoningEffort missing: %v", meta)
	}
	lc, _ := meta["longContext"].(map[string]any)
	if lc == nil || lc["model"] != "maas/deepseek-v4.1-flash" || lc["on"] != true {
		t.Fatalf("longContext mismatch: %v", meta)
	}
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","reasoningEffort":null,"longContext":null}`))
	meta = readMeta()
	if _, has := meta["reasoningEffort"]; has {
		t.Fatalf("reasoningEffort not cleared: %v", meta)
	}
	if _, has := meta["longContext"]; has {
		t.Fatalf("longContext not cleared: %v", meta)
	}
	if meta["updatedAt"] != updatedAfterTurn || meta["projectId"] != "p1" || meta["createdAt"] != float64(1000) {
		t.Fatalf("metadata patch altered updatedAt/identity: %v (want updatedAt=%v)", meta, updatedAfterTurn)
	}
	_ = s
}

func TestManagedTitlePrecedenceAndPostTurnDiskLookup(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	r.SetNativeTitleRetryDelays([]time.Duration{0, 10 * time.Millisecond})

	lookupCalls := 0
	var lookupMu sync.Mutex
	releaseDiskLookup := make(chan struct{})
	r.SetNativeTitleLookup(func(ctx context.Context, backend, nativeSID, _ string) string {
		lookupMu.Lock()
		lookupCalls++
		callNum := lookupCalls
		lookupMu.Unlock()
		if backend != "claude" || !strings.HasPrefix(nativeSID, "claude_") || callNum < 2 {
			return ""
		}
		select {
		case <-ctx.Done():
			return ""
		case <-releaseDiskLookup:
			return "Disk Summary Native Title"
		}
	})

	tf := &titleModelFake{ingressFake: &ingressFake{name: "claude"}, model: "claude-sonnet"}
	r.Register("claude", func(id string) (cr.Target, error) {
		tgt, err := tf.ingressFake.target(id)
		tgt.Runtime = tf
		return tgt, err
	})

	requireOK(t, c.call("conversations.put", `{"meta":{"id":"c","backend":"nomi","name":"新对话","createdAt":1000,"updatedAt":1000,"projectId":"p1"},"messages":[]}`))
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","permissionMode":"ask","confirm":true}`))

	g := generation(t, c)
	requireOK(t, c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"m1","turnId":"t1","text":"排查构建脚本为什么找不到依赖","expectedGeneration":%d}`, g)))

	readMeta := func(id string) map[string]any {
		t.Helper()
		raw := requireOK(t, c.call("conversations.state", `{}`))
		b, _ := json.Marshal(raw)
		var state struct {
			Conversations []map[string]any `json:"conversations"`
		}
		_ = json.Unmarshal(b, &state)
		for _, conv := range state.Conversations {
			if conv["id"] == id {
				return conv
			}
		}
		t.Fatalf("conversation %s missing", id)
		return nil
	}

	waitName := func(id, want string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			if got, _ := readMeta(id)["name"].(string); got == want {
				return
			}
			time.Sleep(15 * time.Millisecond)
		}
		t.Fatalf("conversation %s name = %v, want %q", id, readMeta(id)["name"], want)
	}

	// 1. Heuristic title set when turn starts.
	waitName("c", "排查构建脚本为什么找不到依赖")

	// 2. Smart title (autoTitle: true) upgrades heuristic title while disk lookup is gated.
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"构建依赖排查","autoTitle":true}`))
	waitName("c", "构建依赖排查")

	// 3. Disk native title lookup supersedes smart title on retry.
	close(releaseDiskLookup)
	waitName("c", "Disk Summary Native Title")

	// 4. Late smart autoTitle must NOT overwrite native title.
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"迟到的智能标题","autoTitle":true}`))
	if got := readMeta("c")["name"]; got != "Disk Summary Native Title" {
		t.Fatalf("late smart autoTitle overwrote native title: got %v", got)
	}

	// 5. Real-time native push CAN still update an earlier native title before manual rename.
	tf.pushTitle("Updated Stream Native Title")
	waitName("c", "Updated Stream Native Title")

	// 6. Manual rename locks against both late autoTitle and native title.
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"用户手动定稿标题"}`))
	requireOK(t, c.call("conversations.runtimeUpdateMeta", `{"id":"c","name":"再次智能尝试","autoTitle":true}`))
	tf.pushTitle("Should Not Replace Manual")
	if got := readMeta("c")["name"]; got != "用户手动定稿标题" {
		t.Fatalf("manual title was overwritten: got %v", got)
	}
}

func TestManagedIPCRewindAndResendFollowsCurrentBackendAndReopensCleanly(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	claudeFake, grokFake := &ingressFake{name: "claude"}, &ingressFake{name: "grok"}
	r.Register("claude", claudeFake.target)
	r.Register("grok", func(id string) (cr.Target, error) {
		tgt, err := grokFake.target(id)
		cfg := r.ConfigFor(id, "grok")
		if cfg.Model != "" {
			tgt.Env.Model = cfg.Model
		}
		return tgt, err
	})

	requireOK(t, c.call("conversations.put", `{"meta":{"id":"c","backend":"nomi","name":"rewind test","createdAt":1000,"updatedAt":1000},"messages":[]}`))
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "m1"))
	requireOK(t, sendIngress(t, c, "m2"))
	if claudeFake.count() != 2 {
		t.Fatalf("expected 2 claude turns before switch, got %d", claudeFake.count())
	}

	// Switch to grok with explicit model and verify runtimeRewind rejects non-user IDs with BAD_INPUT.
	g := generation(t, c)
	requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"grok","model":"grok-4.7-build-fast","confirm":true,"expectedGeneration":%d}`, g)))

	msgsRaw := requireOK(t, c.call("conversations.messages", `{"id":"c"}`))
	msgsBytes, _ := json.Marshal(msgsRaw)
	var beforeMsgs struct {
		Messages []struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(msgsBytes, &beforeMsgs)
	if len(beforeMsgs.Messages) != 4 {
		t.Fatalf("expected 4 projected messages before rewind, got %s", msgsBytes)
	}
	assistantID := beforeMsgs.Messages[3].ID
	if bad := c.call("conversations.runtimeRewind", fmt.Sprintf(`{"id":"c","messageId":%q}`, assistantID)); bad.T != "err" || bad.Error.Code != "BAD_INPUT" {
		t.Fatalf("expected BAD_INPUT when rewinding assistant message, got %+v", bad)
	}

	// Rewind from second user message m2.
	g = generation(t, c)
	rwRaw := requireOK(t, c.call("conversations.runtimeRewind", fmt.Sprintf(`{"id":"c","messageId":"m2","expectedGeneration":%d}`, g)))
	rwBytes, _ := json.Marshal(rwRaw)
	var rwState struct {
		Backend    string
		Model      string
		Generation uint64
		Phase      string
	}
	_ = json.Unmarshal(rwBytes, &rwState)
	if rwState.Backend != "grok" || rwState.Model != "grok-4.7-build-fast" || rwState.Phase != "idle" {
		t.Fatalf("unexpected state after rewind: %s", rwBytes)
	}

	afterRewindRaw := requireOK(t, c.call("conversations.messages", `{"id":"c"}`))
	afterRewindBytes, _ := json.Marshal(afterRewindRaw)
	var afterRewind struct {
		Messages []struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(afterRewindBytes, &afterRewind)
	if len(afterRewind.Messages) != 2 || afterRewind.Messages[0].ID != "m1" {
		t.Fatalf("expected only first turn projected after rewind m2, got %s", afterRewindBytes)
	}

	// Resend edited second turn -> must execute on currently active grok backend, handing off only m1 turn.
	requireOK(t, c.call("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"m2_edit","turnId":"t_m2_edit","text":"edited second prompt","expectedGeneration":%d}`, rwState.Generation)))
	if grokFake.count() != 1 || claudeFake.count() != 2 {
		t.Fatalf("resend did not execute exclusively on active backend grok: grok=%d claude=%d", grokFake.count(), claudeFake.count())
	}
	grokCall := grokFake.call(0)
	if grokCall.Plan.RequestBody != "edited second prompt" {
		t.Fatalf("unexpected resend request body: %q", grokCall.Plan.RequestBody)
	}
	if !strings.Contains(grokCall.Plan.Payload, "request m1") || strings.Contains(grokCall.Plan.Payload, "request m2") {
		t.Fatalf("resend payload did not accurately carry post-rewind history: %s", grokCall.Plan.Payload)
	}

	// Release and reopen from durable managed-v2 document to verify persistence integrity.
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	_, r2, c2 := fixtureIngress(t, dir)
	r2.Register("claude", claudeFake.target)
	r2.Register("grok", grokFake.target)
	reopenedStateRaw := requireOK(t, c2.call("conversations.runtimeState", `{"id":"c"}`))
	reopenedStateBytes, _ := json.Marshal(reopenedStateRaw)
	var reopenedState struct {
		Backend string
		Phase   string
	}
	_ = json.Unmarshal(reopenedStateBytes, &reopenedState)
	if reopenedState.Backend != "grok" || reopenedState.Phase != "completed" {
		t.Fatalf("reopened runtime state mismatch: %s", reopenedStateBytes)
	}
	reopenedRaw := requireOK(t, c2.call("conversations.messages", `{"id":"c"}`))
	reopenedBytes, _ := json.Marshal(reopenedRaw)
	var reopened struct {
		Messages []struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(reopenedBytes, &reopened)
	if len(reopened.Messages) != 4 || reopened.Messages[2].ID != "m2_edit" || reopened.Messages[2].Content != "edited second prompt" {
		t.Fatalf("reopened messages after rewind+resend mismatch: %s", reopenedBytes)
	}
}

func TestManagedSwitchExposesLongContextInRuntimeView(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	claudeFake := &ingressFake{name: "claude"}
	r.Register("claude", func(id string) (cr.Target, error) {
		tgt, err := claudeFake.target(id)
		cfg := r.ConfigFor(id, "claude")
		tgt.Identity.Source = cfg.Source
		if cfg.Model != "" {
			tgt.Env.Model = cfg.Model
		}
		return tgt, err
	})

	requireOK(t, c.call("conversations.put", `{"meta":{"id":"c","backend":"nomi","name":"lc view","createdAt":1000,"updatedAt":1000},"messages":[]}`))
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","source":"thirdParty","model":"p/m1","confirm":true}`))

	g := generation(t, c)
	onRaw := requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"claude","longContext":"on","confirm":true,"expectedGeneration":%d}`, g)))
	onBytes, _ := json.Marshal(onRaw)
	var onView struct {
		LongContext *bool `json:"longContext"`
	}
	_ = json.Unmarshal(onBytes, &onView)
	if onView.LongContext == nil || !*onView.LongContext {
		t.Fatalf("expected longContext=true in RuntimeView, got %s", onBytes)
	}

	g = generation(t, c)
	defRaw := requireOK(t, c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"c","backend":"claude","longContext":"default","confirm":true,"expectedGeneration":%d}`, g)))
	defBytes, _ := json.Marshal(defRaw)
	var defView map[string]any
	_ = json.Unmarshal(defBytes, &defView)
	if _, has := defView["longContext"]; has {
		t.Fatalf("expected longContext omitted after default reset, got %s", defBytes)
	}
}

func TestManagedInteractiveOnlyRuntimeLockAndAdoption(t *testing.T) {
	dir := t.TempDir()
	_, r, c := fixtureIngress(t, dir)
	claudeFake := &ingressFake{name: "claude"}
	agyFake := &ingressFake{name: "antigravity"}
	r.Register("claude", claudeFake.target)
	r.Register("antigravity", agyFake.target)

	// 1. Non-empty conversation cannot adopt interactive-only antigravity -> BAD_INPUT
	requireOK(t, c.call("conversations.put", `{"meta":{"id":"non_empty","backend":"nomi","name":"non empty","createdAt":1000,"updatedAt":1000},"messages":[{"id":"m1","role":"user","content":"hi","timestamp":1001}]}`))
	fAdoptNonEmpty := c.call("conversations.runtimeAdopt", `{"id":"non_empty","backend":"antigravity","source":"local","confirm":true}`)
	if fAdoptNonEmpty.T != "err" || fAdoptNonEmpty.Error == nil || fAdoptNonEmpty.Error.Code != "BAD_INPUT" {
		t.Fatalf("runtimeAdopt antigravity on non-empty chat = %+v, want BAD_INPUT", fAdoptNonEmpty)
	}

	// 2. Empty conversation CAN adopt antigravity, then switching out to claude is forbidden -> BAD_INPUT
	requireOK(t, c.call("conversations.put", `{"meta":{"id":"empty_agy","backend":"nomi","name":"empty","createdAt":1000,"updatedAt":1000},"messages":[]}`))
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"empty_agy","backend":"antigravity","source":"local","confirm":true}`))
	fSwitchOut := c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"empty_agy","backend":"claude","source":"local","confirm":true,"expectedGeneration":%d}`, 1))
	// Fetch current generation to ensure the failure is due to lock, not generation conflict.
	stBytes, _ := json.Marshal(requireOK(t, c.call("conversations.runtimeState", `{"id":"empty_agy"}`)))
	var agySt struct {
		Generation int `json:"generation"`
	}
	_ = json.Unmarshal(stBytes, &agySt)
	fSwitchOut = c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"empty_agy","backend":"claude","source":"local","confirm":true,"expectedGeneration":%d}`, agySt.Generation))
	if fSwitchOut.T != "err" || fSwitchOut.Error == nil || fSwitchOut.Error.Code != "BAD_INPUT" {
		t.Fatalf("runtimeSwitch out of antigravity = %+v, want BAD_INPUT", fSwitchOut)
	}

	// 3. Conversation on claude cannot switch into antigravity -> BAD_INPUT
	requireOK(t, c.call("conversations.put", `{"meta":{"id":"on_claude","backend":"nomi","name":"claude","createdAt":1000,"updatedAt":1000},"messages":[]}`))
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"on_claude","backend":"claude","source":"local","confirm":true}`))
	cBytes, _ := json.Marshal(requireOK(t, c.call("conversations.runtimeState", `{"id":"on_claude"}`)))
	var claudeSt struct {
		Generation int `json:"generation"`
	}
	_ = json.Unmarshal(cBytes, &claudeSt)
	fSwitchIn := c.call("conversations.runtimeSwitch", fmt.Sprintf(`{"id":"on_claude","backend":"antigravity","source":"local","confirm":true,"expectedGeneration":%d}`, claudeSt.Generation))
	if fSwitchIn.T != "err" || fSwitchIn.Error == nil || fSwitchIn.Error.Code != "BAD_INPUT" {
		t.Fatalf("runtimeSwitch into antigravity from claude = %+v, want BAD_INPUT", fSwitchIn)
	}
}
