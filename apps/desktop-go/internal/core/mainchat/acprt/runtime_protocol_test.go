package acprt

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestIdentityIncludesSortedExtraDirsAndAntigravityKeepsElicitationDisabled(t *testing.T) {
	tmp := t.TempDir()
	fakeBin := filepath.Join(tmp, "gemini")
	fakeRepo := filepath.Join(tmp, "repo")
	if err := os.WriteFile(fakeBin, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(fakeRepo, 0o700); err != nil {
		t.Fatal(err)
	}
	binInfo, err := os.Stat(fakeBin)
	if err != nil {
		t.Fatal(err)
	}
	repoInfo, err := os.Stat(fakeRepo)
	if err != nil {
		t.Fatal(err)
	}

	id1 := identityFor(Config{
		BackendID:  "gemini",
		Executable: fakeBin,
		Cwd:        fakeRepo,
		ExtraDirs:  []string{"/b", "/a"},
	}, binInfo, repoInfo)
	id2 := identityFor(Config{
		BackendID:  "gemini",
		Executable: fakeBin,
		Cwd:        fakeRepo,
		ExtraDirs:  []string{"/a", "/b"},
	}, binInfo, repoInfo)
	id3 := identityFor(Config{
		BackendID:  "gemini",
		Executable: fakeBin,
		Cwd:        fakeRepo,
		ExtraDirs:  []string{"/a"},
	}, binInfo, repoInfo)
	if id1.LaunchFingerprint != id2.LaunchFingerprint {
		t.Fatalf("expected canonical sorted ExtraDirs fingerprint match: %q vs %q", id1.LaunchFingerprint, id2.LaunchFingerprint)
	}
	if id1.LaunchFingerprint == id3.LaunchFingerprint {
		t.Fatalf("expected different ExtraDirs to yield distinct fingerprints")
	}

	if runtime.GOOS == "windows" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	rpcLog := filepath.Join(dir, "rpc.log")
	t.Setenv("GO_ACP_HELPER_MODE", "agy_compliance")
	t.Setenv("GO_ACP_RPC_LOG", rpcLog)
	wrapper := filepath.Join(dir, "acp-cli")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	// Verify via Factory with OnQuestion configured that antigravity still omits elicitation.
	proj := filepath.Join(dir, "proj")
	cfgDir := filepath.Join(dir, "cfg")
	_ = os.MkdirAll(proj, 0o700)
	_ = os.MkdirAll(cfgDir, 0o700)
	f2 := New("antigravity", func(string) (Config, error) {
		return Config{
			BackendID:  "antigravity",
			Executable: wrapper,
			Cwd:        proj,
			ConfigDir:  cfgDir,
			ExtraDirs:  []string{filepath.Join(dir, "extra")},
			OnQuestion: func(string, *util.Obj, func(*util.Obj, bool)) {},
		}, nil
	})
	defer f2.Release("conv-agy-no-elic")
	target, err := f2.Target("conv-agy-no-elic")
	if err != nil {
		t.Fatal(err)
	}
	r := target.Runtime.(*Runtime)
	rec := r.Recover(context.Background(), cr.RecoveryRequest{
		Token: cr.AttemptToken{ConversationID: "conv-agy-no-elic", AttemptID: "a1", Generation: 1},
	})
	if rec.Kind != cr.RecoveryNew {
		t.Fatalf("recover = %+v", rec)
	}
	raw, err := os.ReadFile(rpcLog)
	if err != nil {
		t.Fatal(err)
	}
	var checkedInit bool
	for _, line := range splitNonEmptyLines(string(raw)) {
		var msg map[string]any
		if json.Unmarshal([]byte(line), &msg) != nil || msg["method"] != "initialize" {
			continue
		}
		checkedInit = true
		params, _ := msg["params"].(map[string]any)
		cc, _ := params["clientCapabilities"].(map[string]any)
		if _, has := cc["elicitation"]; has {
			t.Fatalf("antigravity must not advertise elicitation even when OnQuestion is set: %s", line)
		}
	}
	if !checkedInit {
		t.Fatal("missing initialize RPC log")
	}
}

func TestRuntimeApproveOptionAndRuntimeEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	r, release := newHelperRuntime(t, "gemini", "approval_allow")
	defer release()

	ctx := context.Background()
	tok := cr.AttemptToken{ConversationID: "conv-opt", AttemptID: "a1", Generation: 1}
	rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
	if rec.Kind != cr.RecoveryNew {
		t.Fatalf("recover = %+v", rec)
	}

	var mu sync.Mutex
	var approvalEvent cr.Event
	approvalCh := make(chan struct{}, 1)
	done := make(chan cr.Event, 1)
	sub := r.Start(ctx, cr.RuntimeRequest{
		Token:           tok,
		NativeSessionID: rec.NativeSessionID,
		Plan:            cr.Plan{ID: "p-1", RequestBody: "need permission"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventApproval {
			mu.Lock()
			approvalEvent = e
			mu.Unlock()
			select {
			case approvalCh <- struct{}{}:
			default:
			}
		}
		if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
			done <- e
		}
		return nil
	})
	if sub.Kind != cr.SubmitAccepted {
		t.Fatalf("Start = %+v", sub)
	}

	<-approvalCh
	mu.Lock()
	ev := approvalEvent
	mu.Unlock()
	if ev.ApprovalInfo == nil || len(ev.ApprovalInfo.Options) != 2 || ev.ApprovalInfo.Options[0].ID != "allow-once" {
		t.Fatalf("expected ApprovalInfo.Options populated, got %+v", ev.ApprovalInfo)
	}
	if err := r.Approve(ctx, cr.ApprovalDecision{
		Token:           tok,
		NativeSessionID: rec.NativeSessionID,
		ApprovalID:      ev.ApprovalID,
		Allow:           true,
		OptionID:        "allow-once",
	}); err != nil {
		t.Fatalf("Approve with OptionID: %v", err)
	}
	if last := <-done; last.Kind != cr.EventCompleted {
		t.Fatalf("expected EventCompleted, got %+v", last)
	}
}

func splitNonEmptyLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if line != "" {
				out = append(out, line)
			}
			start = i + 1
		}
	}
	return out
}

func TestAntigravityDefaultAutoFallsBackToAcceptEditsAndSyncsAvailableModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell wrapper fixture")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cli.ClearLocalAuthCache("")
	t.Cleanup(func() { cli.ClearLocalAuthCache("") })

	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	cfg := filepath.Join(dir, "cfg")
	modeLog := filepath.Join(dir, "set_mode.txt")
	for _, d := range []string{proj, cfg} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("GO_ACP_HELPER_MODE", "agy_auto_fallback")
	t.Setenv("GO_ACP_SET_MODE_LOG", modeLog)
	t.Setenv("GO_ACP_SET_MODE_APPEND", "1")
	wrapper := filepath.Join(dir, "acp-cli")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	f := New("antigravity", func(string) (Config, error) {
		return Config{BackendID: "antigravity", Executable: wrapper, Cwd: proj, ConfigDir: cfg}, nil
	})
	defer f.Release("conv-agy-fallback")

	target, err := f.Target("conv-agy-fallback")
	if err != nil {
		t.Fatal(err)
	}
	if target.Env.PermissionMode != "auto" {
		t.Fatalf("default antigravity PermissionMode = %q, want auto", target.Env.PermissionMode)
	}
	r := target.Runtime.(*Runtime)

	var (
		mu         sync.Mutex
		gotMode    string
		gotAvail   []string
		gotModeCh  = make(chan struct{}, 1)
		gotAvailCh = make(chan struct{}, 1)
	)
	r.SetModeHandler(func(mode string) {
		mu.Lock()
		gotMode = mode
		mu.Unlock()
		select {
		case gotModeCh <- struct{}{}:
		default:
		}
	})
	r.SetAvailableModesHandler(func(modes []string) {
		mu.Lock()
		gotAvail = append([]string(nil), modes...)
		mu.Unlock()
		select {
		case gotAvailCh <- struct{}{}:
		default:
		}
	})

	rec := r.Recover(context.Background(), cr.RecoveryRequest{
		Token: cr.AttemptToken{ConversationID: "conv-agy-fallback", AttemptID: "af1", Generation: 1},
	})
	if rec.Kind != cr.RecoveryNew || rec.NativeSessionID == "" {
		t.Fatalf("Recover = %+v, want RecoveryNew", rec)
	}

	select {
	case <-gotAvailCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for availableModes callback")
	}
	select {
	case <-gotModeCh:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for fallback mode callback")
	}

	mu.Lock()
	modeCopy := gotMode
	availCopy := append([]string(nil), gotAvail...)
	mu.Unlock()
	if modeCopy != "acceptEdits" {
		t.Fatalf("fallback emitted mode = %q, want acceptEdits", modeCopy)
	}
	wantAvail := []string{"deny", "ask", "acceptEdits", "auto"}
	if !slices.Equal(availCopy, wantAvail) {
		t.Fatalf("availableModes = %v, want %v", availCopy, wantAvail)
	}

	raw, err := os.ReadFile(modeLog)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Fields(string(raw))
	if !slices.Equal(lines, []string{"auto", "accept-edits"}) {
		t.Fatalf("session/set_mode sequence = %v, want [auto accept-edits]", lines)
	}
}
