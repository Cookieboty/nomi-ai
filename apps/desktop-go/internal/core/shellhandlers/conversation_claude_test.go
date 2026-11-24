package shellhandlers_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/claudert"
)

// This is ONLY a fake executable: testdata/fakeclaude, built for this OS and
// copied into the fixture (see conversation_claude_fake_test.go). No installed
// Claude, login, provider, network or model is used. It speaks the existing
// official driver's input/output frames over its own stdin/stdout/stderr.

type claudeWire struct {
	Kind string
	Data json.RawMessage
}

func claudeFixture(t *testing.T, mode string) (*claudert.Factory, string) {
	return claudeFixtureWithRegistry(t, mode, nil)
}

func claudeFixtureWithRegistry(t *testing.T, mode string, reg *mainchat.Registry) (*claudert.Factory, string) {
	t.Helper()
	dir := t.TempDir()
	// The executable sits in the fixture directory the driver runs it in: the
	// stand-in reads its mode and journals wire.jsonl from its working
	// directory, never next to the binary.
	exe := installFakeClaude(t, dir)
	setClaudeMode(t, dir, mode)
	f := claudert.New(func(convID string) (claudert.Config, error) {
		cfg := claudert.Config{Executable: exe, Cwd: dir, ConfigDir: filepath.Join(dir, "config")}
		if reg != nil {
			cfg.PermissionMode = reg.ConfigFor(convID, "claude").PermissionMode
		}
		return cfg, nil
	})
	return f, dir
}
func setClaudeMode(t *testing.T, dir, mode string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "mode"), []byte(mode), 0600); err != nil {
		t.Fatal(err)
	}
}
func readClaudeWire(t *testing.T, dir string) []claudeWire {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "wire.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []claudeWire
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var e claudeWire
		if json.Unmarshal([]byte(line), &e) != nil {
			t.Fatalf("invalid fixture journal: %s", line)
		}
		out = append(out, e)
	}
	return out
}

type nativeView struct {
	Phase      cr.Phase
	Recovery   cr.RecoveryKind
	Approvals  []string
	Token      cr.AttemptToken
	Generation uint64
	Detail     string
}

func waitClaudeState(t *testing.T, c *convSession, check func(nativeView) bool) nativeView {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	var st nativeView
	for time.Now().Before(deadline) {
		b, _ := json.Marshal(requireOK(t, c.call("conversations.runtimeState", `{"id":"c"}`)))
		if err := json.Unmarshal(b, &st); err != nil {
			t.Fatal(err)
		}
		if check(st) {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("native state timed out: %+v", st)
	return st
}
func awaitClaude(t *testing.T, c *convSession, phase cr.Phase) nativeView {
	return waitClaudeState(t, c, func(s nativeView) bool { return s.Phase == phase })
}
func TestClaudeOfficialSubprocessActualIPCProviderlessWarmSwitch(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "FAKE_MUST_BE_STRIPPED")
	storeDir := t.TempDir()
	s, r, c := fixtureIngress(t, storeDir)
	f, dir := claudeFixture(t, "success")
	r.RegisterOwned("claude", f.Target, f.Release)
	api := &ingressFake{name: "api"}
	r.Register("api", api.target)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	first := awaitClaude(t, c, cr.PhaseCompleted)
	if first.Recovery != cr.RecoveryNew {
		t.Fatal(first)
	}
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"api"}`))
	requireOK(t, sendIngress(t, c, "two"))
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`))
	requireOK(t, sendIngress(t, c, "three"))
	last := awaitClaude(t, c, cr.PhaseCompleted)
	if last.Recovery != cr.RecoveryResumed {
		t.Fatalf("warm native binding lost: %+v", last)
	}
	launches := 0
	payloads := []string{}
	for _, e := range readClaudeWire(t, dir) {
		var d map[string]any
		_ = json.Unmarshal(e.Data, &d)
		if e.Kind == "launch" {
			launches++
			args := fmt.Sprint(d["args"])
			for _, flag := range []string{"--input-format stream-json", "--output-format stream-json", "--permission-prompt-tool stdio", "--replay-user-messages", "--permission-mode auto", "--strict-mcp-config", "--session-id"} {
				if !strings.Contains(args, flag) {
					t.Fatalf("missing official flag %s in %s", flag, args)
				}
			}
			for _, unwanted := range []string{"--safe-mode", "--restricted", "--tools Read,Glob,Grep"} {
				if strings.Contains(args, unwanted) {
					t.Fatalf("default auto profile should not pass legacy flag %s in %s", unwanted, args)
				}
			}
			// Compare physical paths: macOS reports /private/var for /var TMPDIR.
			realDir, err := filepath.EvalSymlinks(dir)
			if err != nil {
				t.Fatal(err)
			}
			physical := func(p string) string {
				if r, err := filepath.EvalSymlinks(p); err == nil {
					return r
				}
				return p
			}
			if d["apiKeyPresent"] != false || physical(fmt.Sprint(d["cwd"])) != realDir || physical(fmt.Sprint(d["config"])) != filepath.Join(realDir, "config") || strings.Contains(args, "--bare") {
				t.Fatal("official login/source isolation broken", d)
			}
		}
		if e.Kind == "input" && d["type"] == "user" {
			payloads = append(payloads, d["message"].(map[string]any)["content"].(string))
		}
	}
	if launches != 1 || len(payloads) != 2 || !strings.Contains(payloads[0], "retained API history") || strings.Contains(payloads[1], "request one") || !strings.Contains(payloads[1], "request two") || strings.Count(payloads[1], "request three") != 1 {
		t.Fatalf("full/delta/current request mismatch launches=%d payloads=%q", launches, payloads)
	}
	messages, err := s.Messages("c", 0)
	if err != nil || len(messages) != 7 {
		t.Fatalf("product transcript lost: %d %v", len(messages), err)
	}
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"api"}`))
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	s2, r2, c2 := fixtureIngress(t, storeDir)
	f2, _ := claudeFixture(t, "success")
	r2.RegisterOwned("claude", f2.Target, f2.Release)
	// Projection survives reload even before a runtime is reattached.
	if msgs, err := s2.Messages("c", 0); err != nil || len(msgs) != 7 {
		t.Fatal("restart projection", err, len(msgs))
	}
	_ = c2
}

func TestClaudeOfficialSubprocessFailuresNeverFabricateDelivery(t *testing.T) {
	for _, mode := range []string{"startup-error", "nonzero", "clean-exit", "partial-exit", "result-error", "malformed", "malformed-then-echo", "bad-utf8", "oversize", "bad-sid", "bad-mode", "unsupported"} {
		t.Run(mode, func(t *testing.T) {
			s, r, c := fixtureIngress(t, t.TempDir())
			f, dir := claudeFixtureWithRegistry(t, mode, r)
			r.RegisterOwned("claude", f.Target, f.Release)
			seedIngress(t, c)
			adoptBody := `{"id":"c","backend":"claude","confirm":true}`
			if mode == "unsupported" {
				adoptBody = `{"id":"c","backend":"claude","permissionMode":"deny","confirm":true}`
			}
			requireOK(t, c.call("conversations.runtimeAdopt", adoptBody))
			sent := sendIngress(t, c, "failed")
			phase := cr.PhaseUncertain
			if mode == "startup-error" {
				phase = cr.PhaseFailed
				if sent.T != "err" {
					t.Fatal("startup failure claimed submission")
				}
			} else {
				requireOK(t, sent)
			}
			awaitClaude(t, c, phase)
			doc, err := s.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			wantReceipts := 0
			if mode == "unsupported" || mode == "partial-exit" || mode == "result-error" {
				wantReceipts = 1
			}
			if len(doc.State.Receipts) != wantReceipts || len(doc.State.History) != 2 || len(doc.State.Completed) != 0 {
				t.Fatalf("fabricated completion or delivery: %+v", doc.State)
			}
			if mode != "startup-error" {
				if sendIngress(t, c, "automatic-again").T != "err" {
					t.Fatal("uncertain action allowed repeat")
				}
			}
			for _, e := range readClaudeWire(t, dir) {
				if e.Kind == "input" && strings.Contains(string(e.Data), `"type": "control_response"`) {
					t.Fatal("unsupported native action was auto-approved")
				}
			}
		})
	}
}
func TestClaudeOfficialSubprocessApprovalExplicitAndBoundToOriginalInput(t *testing.T) {
	for _, scriptMode := range []string{"approval", "unsupported"} {
		for _, allow := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%v", scriptMode, allow), func(t *testing.T) {
				s, r, c := fixtureIngress(t, t.TempDir())
				f, dir := claudeFixture(t, scriptMode)
				r.RegisterOwned("claude", f.Target, f.Release)
				seedIngress(t, c)
				requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
				requireOK(t, sendIngress(t, c, "permission"))
				st := waitClaudeState(t, c, func(st nativeView) bool { return len(st.Approvals) == 1 })
				if c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`).T != "err" {
					t.Fatal("switched with approval outstanding")
				}
				forged, _ := json.Marshal(map[string]any{"id": "c", "token": st.Token, "approvalId": "forged", "allow": true})
				if c.call("conversations.runtimeApprove", string(forged)).T != "err" {
					t.Fatal("forged approval accepted")
				}
				input, _ := json.Marshal(map[string]any{"id": "c", "token": st.Token, "approvalId": "permit", "allow": allow})
				requireOK(t, c.call("conversations.runtimeApprove", string(input)))
				awaitClaude(t, c, cr.PhaseCompleted)
				messages, err := s.Messages("c", 0)
				if err != nil || len(messages) != 3 {
					t.Fatalf("permission completion %d %v", len(messages), err)
				}
				answers := 0
				for _, e := range readClaudeWire(t, dir) {
					var q map[string]any
					_ = json.Unmarshal(e.Data, &q)
					if e.Kind == "input" && q["type"] == "control_response" {
						answers++
						a := q["response"].(map[string]any)["response"].(map[string]any)
						want := "deny"
						if allow {
							want = "allow"
						}
						if a["behavior"] != want {
							t.Fatal("approval mapping", a)
						}
					}
				}
				if answers != 1 {
					t.Fatalf("expected exactly one explicit permission response, got %d", answers)
				}
			})
		}
	}
}
func TestClaudeOfficialSubprocessCancelDropsBufferedLateText(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "no-echo-hang")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "cancel"))
	awaitClaude(t, c, cr.PhaseRunning)
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Receipts) != 0 {
		t.Fatal("stdin acceptance must not ACK", err)
	}
	requireOK(t, c.call("conversations.runtimeCancel", `{"id":"c"}`))
	awaitClaude(t, c, cr.PhaseCanceled)
	time.Sleep(20 * time.Millisecond)
	after, err := s.ReadManaged("c")
	if err != nil || len(after.State.History) != 2 || len(after.State.Completed) != 0 || len(after.State.Receipts) != 0 {
		t.Fatalf("late native bytes mutated authority: %+v %v", after.State, err)
	}
	if c.call("conversations.runtimeApprove", `{"id":"c","approvalId":"permit","allow":true}`).T != "err" {
		t.Fatal("canceled generation could approve")
	}
}
func TestClaudeOfficialSubprocessColdResumeUnknownNeverSendsDelta(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, dir := claudeFixture(t, "success")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseCompleted)
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	if got := sendIngress(t, c, "cold"); got.T != "err" {
		t.Fatal("unproven cold resumption accepted")
	}
	st := awaitClaude(t, c, cr.PhaseUncertain)
	if st.Recovery != cr.RecoveryUnknown {
		t.Fatal(st)
	}
	users, resumes := 0, 0
	for _, e := range readClaudeWire(t, dir) {
		var q map[string]any
		_ = json.Unmarshal(e.Data, &q)
		if e.Kind == "launch" && strings.Contains(fmt.Sprint(q["args"]), "--resume") {
			resumes++
		}
		if e.Kind == "input" && q["type"] == "user" {
			users++
		}
	}
	if users != 1 || resumes != 1 {
		t.Fatalf("cold resume fed unproven context: user frames=%d resumes=%d", users, resumes)
	}
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Receipts) != 1 || len(doc.State.Completed) != 1 {
		t.Fatal("unknown recovery changed prior delivery", err)
	}
	if sendIngress(t, c, "must-not-replay").T != "err" {
		t.Fatal("unknown recovery auto replayed")
	}
}
func TestClaudeOfficialSubprocessProvenMissingResumeFallsBackFull(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, dir := claudeFixture(t, "success")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseCompleted)
	first, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	setClaudeMode(t, dir, "missing")
	requireOK(t, sendIngress(t, c, "two"))
	st := awaitClaude(t, c, cr.PhaseCompleted)
	if st.Recovery != cr.RecoveryFallback {
		t.Fatal("missing native not explicit fallback", st)
	}
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Bindings) != 2 || doc.State.Bindings[0].NativeSessionID != first.State.Bindings[0].NativeSessionID || doc.State.Bindings[0].NativeSessionID == doc.State.Bindings[1].NativeSessionID {
		t.Fatalf("fallback clobbered native identity: %+v %v", doc.State.Bindings, err)
	}
	frames := []string{}
	for _, e := range readClaudeWire(t, dir) {
		var q map[string]any
		_ = json.Unmarshal(e.Data, &q)
		if e.Kind == "input" && q["type"] == "user" {
			frames = append(frames, q["message"].(map[string]any)["content"].(string))
		}
	}
	if len(frames) != 2 || !strings.Contains(frames[1], "retained API history") || !strings.Contains(frames[1], "request one") || strings.Count(frames[1], "request two") != 1 {
		t.Fatalf("fallback reused stale delta or duplicated current request: %q", frames)
	}
}
func TestClaudeOfficialSubprocessSuccessWithoutReplayStillRequiresResult(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "no-echo")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseCompleted)
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Receipts) != 1 || len(doc.State.Completed) != 1 {
		t.Fatal("validated terminal delivery not recorded", err)
	}
}

func TestClaudeOfficialSubprocessResultOnlyPreservesNativeText(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "result-only")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseCompleted)
	messages, err := s.Messages("c", 0)
	if err != nil || len(messages) != 3 || !strings.Contains(string(messages[2]), "native result-only") {
		t.Fatalf("dropped native terminal text: %s %v", messages, err)
	}
}
func TestClaudeOfficialSubprocessLateBackgroundNeverClaimsIdle(t *testing.T) {
	_, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "late-background")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		st, err := r.State("c")
		if err != nil {
			t.Fatal(err)
		}
		if st.Phase == cr.PhaseUncertain || (st.Phase == cr.PhaseCompleted && !st.Work.Idle()) {
			if got := c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`); got.T != "err" {
				t.Fatal("native background uncertainty allowed idle switch")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("native background activity remained silently idle")
}

func TestClaudeOfficialSubprocessSpawnErrorBeforeSubmission(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, dir := claudeFixture(t, "success")
	if err := os.WriteFile(filepath.Join(dir, "fake-claude"), []byte("not an executable format"), 0700); err != nil {
		t.Fatal(err)
	}
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	if got := sendIngress(t, c, "one"); got.T != "err" {
		t.Fatal("spawn error claimed submission")
	}
	awaitClaude(t, c, cr.PhaseFailed)
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Receipts) != 0 || len(doc.State.Completed) != 0 {
		t.Fatal("spawn failure created delivery", err)
	}
}

func TestClaudeOfficialSubprocessChunkedUnicodePreservesText(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "split-unicode")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "unicode"))
	awaitClaude(t, c, cr.PhaseCompleted)
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.History) != 3 || doc.State.History[2].Text != "分块🙂结果" {
		t.Fatalf("native chunk boundary corrupted Unicode: %+v %v", doc.State.History, err)
	}
}

func TestClaudeOfficialSubprocessExplicitNewNativeAfterUnknownIsFull(t *testing.T) {
	s, r, c := fixtureIngress(t, t.TempDir())
	f, dir := claudeFixture(t, "success")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseCompleted)
	first, err := s.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	if sendIngress(t, c, "cold").T != "err" {
		t.Fatal("unproven cold resumption accepted")
	}
	st := awaitClaude(t, c, cr.PhaseUncertain)
	if st.Recovery != cr.RecoveryUnknown {
		t.Fatal(st)
	}
	if got := c.call("conversations.runtimeResolve", `{"id":"c","decision":"new-native","confirm":true}`); got.T != "err" {
		t.Fatal("resolve without generation was accepted")
	}
	if got := c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`); got.T != "err" {
		t.Fatal("idle-only select allowed during unknown recovery")
	}
	if got := c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"new-native","confirm":false,"expectedGeneration":%d}`, st.Generation)); got.T != "err" {
		t.Fatal("unconfirmed resolve accepted")
	}
	requireOK(t, c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"new-native","confirm":true,"expectedGeneration":%d}`, st.Generation)))
	idle := awaitClaude(t, c, cr.PhaseIdle)
	if sendIngress(t, c, "after-new").T == "err" {
		t.Fatal("explicit new-native still blocked send")
	}
	done := awaitClaude(t, c, cr.PhaseCompleted)
	if done.Recovery != cr.RecoveryNew {
		t.Fatalf("expected RecoveryNew after explicit decision, got %+v", done)
	}
	doc, err := s.ReadManaged("c")
	if err != nil || len(doc.State.Bindings) != 2 {
		t.Fatalf("old binding should be preserved beside the new native: %+v %v", doc.State.Bindings, err)
	}
	var oldKept, newID bool
	for _, b := range doc.State.Bindings {
		if b.NativeSessionID == first.State.Bindings[0].NativeSessionID && b.Status == cr.StatusStale {
			oldKept = true
		}
		if b.NativeSessionID != "" && b.NativeSessionID != first.State.Bindings[0].NativeSessionID && b.Status.Safe() {
			newID = true
		}
	}
	if !oldKept || !newID {
		t.Fatalf("native identity isolation failed: %+v", doc.State.Bindings)
	}
	frames := []string{}
	resumes, usersAfterResolve := 0, 0
	for _, e := range readClaudeWire(t, dir) {
		var q map[string]any
		_ = json.Unmarshal(e.Data, &q)
		if e.Kind == "launch" && strings.Contains(fmt.Sprint(q["args"]), "--resume") {
			resumes++
		}
		if e.Kind == "input" && q["type"] == "user" {
			frames = append(frames, q["message"].(map[string]any)["content"].(string))
			if strings.Contains(fmt.Sprint(q), "after-new") {
				usersAfterResolve++
			}
		}
	}
	// one original success, no user frame on the unknown resume, one full payload after resolve
	if len(frames) != 2 || resumes != 1 || usersAfterResolve != 1 || !strings.Contains(frames[1], "retained API history") || !strings.Contains(frames[1], "request one") || strings.Count(frames[1], "request after-new") != 1 || strings.Contains(frames[1], "request cold") {
		t.Fatalf("explicit new-native was not a full unique current request: frames=%q resumes=%d", frames, resumes)
	}
	_ = idle
}

func TestClaudeOfficialSubprocessLateEventsAfterResolveCannotMutate(t *testing.T) {
	_, r, c := fixtureIngress(t, t.TempDir())
	f, _ := claudeFixture(t, "no-echo-hang")
	r.RegisterOwned("claude", f.Target, f.Release)
	seedIngress(t, c)
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"claude","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitClaude(t, c, cr.PhaseRunning)
	requireOK(t, c.call("conversations.runtimeCancel", `{"id":"c"}`))
	awaitClaude(t, c, cr.PhaseCanceled)
	if got := c.call("conversations.runtimeResolve", `{"id":"c","decision":"new-native","confirm":true,"expectedGeneration":1}`); got.T != "err" {
		t.Fatal("canceled-not-unknown resolve accepted")
	}
}
