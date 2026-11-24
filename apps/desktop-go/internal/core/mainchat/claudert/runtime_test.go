package claudert

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

const fakeClaudeTitleScript = `#!/usr/bin/python3
import sys, json, time
args = sys.argv[1:]
resume = '--resume' in args
sid = args[args.index('--resume' if resume else '--session-id') + 1]
def out(o):
    print(json.dumps(o), flush=True)
n = 0
for line in sys.stdin:
    q = json.loads(line)
    if q['type'] == 'control_request':
        out({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': q['request_id'], 'response': {}}})
    elif q['type'] == 'user':
        n += 1
        out({'type': 'system', 'subtype': 'init', 'session_id': sid, 'permissionMode': 'default'})
        q['session_id'] = sid
        out(q)
        if n == 1:
            out({'type': 'custom-title', 'session_id': sid, 'customTitle': 'Claude Stream Title'})
            out({'type': 'command_lifecycle', 'session_id': sid, 'phase': 'start', 'error': None})
            out({'type': 'assistant', 'session_id': sid, 'message': {'content': [{'type': 'text', 'text': 'hello'}]}})
            out({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': sid, 'result': 'hello'})
            time.sleep(0.05)
            out({'type': 'command_lifecycle', 'session_id': sid, 'phase': 'end'})
            out({'type': 'future_telemetry_notice', 'session_id': sid})
            out({'type': 'summary', 'session_id': sid, 'summary': 'Claude Post-Turn Summary'})
        else:
            out({'type': 'unexpected_control_request', 'request_id': 'req-unknown', 'session_id': sid})
`

func TestClaudeRuntimePassiveTitleEventsAndFailClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake-claude")
	if err := os.WriteFile(exe, []byte(fakeClaudeTitleScript), 0o700); err != nil {
		t.Fatal(err)
	}
	cfgDir := filepath.Join(dir, "cfg")
	_ = os.MkdirAll(cfgDir, 0o700)
	f := New(func(string) (Config, error) {
		return Config{Executable: exe, Cwd: dir, ConfigDir: cfgDir}, nil
	})
	defer f.Release("conv-claude-title")

	target, err := f.Target("conv-claude-title")
	if err != nil {
		t.Fatal(err)
	}
	r := target.Runtime.(*Runtime)
	var mu sync.Mutex
	var gotTitles []string
	r.SetTitleHandler(func(title string) {
		mu.Lock()
		gotTitles = append(gotTitles, title)
		mu.Unlock()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tok1 := cr.AttemptToken{ConversationID: "conv-claude-title", AttemptID: "c1", Generation: 1}
	rec1 := r.Recover(ctx, cr.RecoveryRequest{Token: tok1})
	if rec1.Kind != cr.RecoveryNew || rec1.NativeSessionID == "" {
		t.Fatalf("recover1 = %+v", rec1)
	}
	if sid, cdir := r.NativeSessionMeta(); sid != rec1.NativeSessionID || cdir == "" {
		t.Fatalf("NativeSessionMeta = (%q, %q)", sid, cdir)
	}

	done1 := make(chan cr.Event, 1)
	r.Start(ctx, cr.RuntimeRequest{
		Token:           tok1,
		NativeSessionID: rec1.NativeSessionID,
		Plan:            cr.Plan{ID: "p1", Payload: "hi"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
			done1 <- e
		}
		return nil
	})
	if ev1 := <-done1; ev1.Kind != cr.EventCompleted {
		t.Fatalf("turn1 = %+v", ev1)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		joined := strings.Join(gotTitles, "|")
		mu.Unlock()
		if strings.Contains(joined, "Claude Stream Title") && strings.Contains(joined, "Claude Post-Turn Summary") {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	mu.Lock()
	joined := strings.Join(gotTitles, "|")
	mu.Unlock()
	if !strings.Contains(joined, "Claude Stream Title") || !strings.Contains(joined, "Claude Post-Turn Summary") {
		t.Fatalf("expected custom-title and post-turn summary, got %v", gotTitles)
	}

	// Warm reuse + strict fail-closed on unknown native protocol event on turn 2.
	tok2 := cr.AttemptToken{ConversationID: "conv-claude-title", AttemptID: "c2", Generation: 2}
	rec2 := r.Recover(ctx, cr.RecoveryRequest{Token: tok2, Previous: cr.Binding{ID: "b1", NativeSessionID: rec1.NativeSessionID}})
	if rec2.Kind != cr.RecoveryResumed {
		t.Fatalf("warm recover after post-turn summary failed: %+v", rec2)
	}
	done2 := make(chan cr.Event, 1)
	r.Start(ctx, cr.RuntimeRequest{
		Token:           tok2,
		NativeSessionID: rec1.NativeSessionID,
		Plan:            cr.Plan{ID: "p2", Payload: "trigger-unknown"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
			done2 <- e
		}
		return nil
	})
	if ev2 := <-done2; ev2.Kind != cr.EventFailed {
		t.Fatalf("expected EventFailed for unknown protocol event, got %+v", ev2)
	}
}

const fakeClaudeThirdPartyAndFailureScript = `#!/usr/bin/python3
import sys, json, os
args = sys.argv[1:]
mode = os.environ.get('FAKE_CLAUDE_MODE', 'thirdparty-ok')
sid = args[args.index('--session-id') + 1]
def out(o):
    print(json.dumps(o), flush=True)
for line in sys.stdin:
    q = json.loads(line)
    if q['type'] == 'control_request':
        out({'type': 'control_response', 'response': {'subtype': 'success', 'request_id': q['request_id'], 'response': {}}})
    elif q['type'] == 'user':
        pm = os.environ.get('FAKE_INIT_PM', 'acceptEdits' if mode == 'thirdparty-ok' else 'default')
        out({'type': 'system', 'subtype': 'init', 'session_id': sid, 'permissionMode': 'bypassPermissions' if mode == 'bad-mode' else pm, 'message': 'initialized'})
        q['session_id'] = sid
        out(q)
        if mode == 'thirdparty-ok':
            want_pm = os.environ.get('FAKE_WANT_PM', 'acceptEdits')
            assert '--permission-mode' in args and args[args.index('--permission-mode') + 1] == want_pm, args
            assert '--model' in args and args[args.index('--model') + 1] == 'maas/deepseek-v4.1-flash', args
            out({'type': 'keep_alive', 'session_id': sid})
            out({'type': 'command_lifecycle', 'session_id': sid, 'phase': 'start', 'error': None})
            out({'type': 'auth_status', 'session_id': sid, 'message': 'authenticated'})
            out({'type': 'tool_progress', 'session_id': sid, 'message': 'working'})
            out({'type': 'tool_use_summary', 'session_id': sid, 'message': 'summary'})
            out({'type': 'progress', 'session_id': sid, 'message': 'step'})
            out({'type': 'permission-mode', 'session_id': sid, 'permissionMode': 'default'})
            out({'type': 'assistant', 'session_id': sid, 'message': {'content': [{'type': 'text', 'text': '안녕'}]}})
            out({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': sid, 'result': '안녕'})
            out({'type': 'command_lifecycle', 'session_id': sid, 'phase': 'end'})
            out({'type': 'prompt_suggestion', 'session_id': sid, 'message': 'next?'})
            out({'type': 'last-prompt', 'session_id': sid, 'lastPrompt': 'translate'})
            out({'type': 'rate_limit_event', 'session_id': sid})
        elif mode == 'result-error':
            out({'type': 'result', 'subtype': 'error_during_execution', 'is_error': True, 'session_id': sid, 'errors': ['upstream model quota exceeded']})
        elif mode == 'unknown-request':
            out({'type': 'unexpected_control_request', 'request_id': 'req-1', 'session_id': sid})
`

func TestClaudeThirdPartyFlagsAndPassiveEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	wantModes := []string{"deny", "ask", "acceptEdits", "auto", "bypass"}
	if got := PermissionModes(); !slices.Equal(got, wantModes) {
		t.Fatalf("PermissionModes() = %v, want %v", got, wantModes)
	}
	if !isAllowedClaudeNativeMode("auto", "acceptEdits") || !isAllowedClaudeNativeMode("auto", "default") || !isAllowedClaudeNativeMode("default", "default") {
		t.Fatal("expected equal or safe downgrade permission mode to be allowed")
	}
	if isAllowedClaudeNativeMode("auto", "bypassPermissions") || isAllowedClaudeNativeMode("default", "acceptEdits") || isAllowedClaudeNativeMode("plan", "default") || isAllowedClaudeNativeMode("auto", "unknownMode") {
		t.Fatal("expected permission escalation or unknown mode to be rejected")
	}

	dir := t.TempDir()
	exe := filepath.Join(dir, "fake-claude")
	if err := os.WriteFile(exe, []byte(fakeClaudeThirdPartyAndFailureScript), 0o700); err != nil {
		t.Fatal(err)
	}
	cfgDir := filepath.Join(dir, "cfg")
	_ = os.MkdirAll(cfgDir, 0o700)
	// 默认 PermissionMode 为空 → 兼容键记作 auto，thirdParty 下发 --permission-mode acceptEdits
	f := New(func(string) (Config, error) {
		return Config{
			Executable: exe,
			Cwd:        dir,
			ConfigDir:  cfgDir,
			Source:     "thirdParty",
			Model:      "maas/deepseek-v4.1-flash",
			ExtraEnv:   map[string]string{"FAKE_CLAUDE_MODE": "thirdparty-ok"},
		}, nil
	})
	defer f.Release("conv-thirdparty")

	target, err := f.Target("conv-thirdparty")
	if err != nil {
		t.Fatal(err)
	}
	if target.Env.PermissionMode != "auto" {
		t.Fatalf("default target.Env.PermissionMode = %q, want auto", target.Env.PermissionMode)
	}
	r := target.Runtime.(*Runtime)
	if !slices.Equal(r.Capabilities().PermissionModes, wantModes) {
		t.Fatalf("Capabilities().PermissionModes = %v, want %v", r.Capabilities().PermissionModes, wantModes)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tok := cr.AttemptToken{ConversationID: "conv-thirdparty", AttemptID: "tp1", Generation: 1}
	rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
	if rec.Kind != cr.RecoveryNew || rec.NativeSessionID == "" {
		t.Fatalf("recover = %+v", rec)
	}
	done := make(chan cr.Event, 1)
	var text string
	r.Start(ctx, cr.RuntimeRequest{
		Token:           tok,
		NativeSessionID: rec.NativeSessionID,
		Plan:            cr.Plan{ID: "p-tp", Payload: "翻译成韩文"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventText {
			text = e.Text
		}
		if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
			done <- e
		}
		return nil
	})
	ev := <-done
	if ev.Kind != cr.EventCompleted || text != "안녕" {
		t.Fatalf("thirdParty turn = %+v, text = %q", ev, text)
	}

	// 显式 ask 档位下发 --permission-mode default
	fAsk := New(func(string) (Config, error) {
		return Config{
			Executable:     exe,
			Cwd:            dir,
			ConfigDir:      cfgDir,
			Source:         "thirdParty",
			Model:          "maas/deepseek-v4.1-flash",
			PermissionMode: "ask",
			ExtraEnv:       map[string]string{"FAKE_CLAUDE_MODE": "thirdparty-ok", "FAKE_WANT_PM": "default", "FAKE_INIT_PM": "default"},
		}, nil
	})
	defer fAsk.Release("conv-thirdparty-ask")
	targetAsk, err := fAsk.Target("conv-thirdparty-ask")
	if err != nil || targetAsk.Env.PermissionMode != "ask" {
		t.Fatalf("ask target = %+v err=%v", targetAsk.Env, err)
	}
	rAsk := targetAsk.Runtime.(*Runtime)
	tokAsk := cr.AttemptToken{ConversationID: "conv-thirdparty-ask", AttemptID: "tp2", Generation: 1}
	recAsk := rAsk.Recover(ctx, cr.RecoveryRequest{Token: tokAsk})
	if recAsk.Kind != cr.RecoveryNew {
		t.Fatalf("ask recover = %+v", recAsk)
	}
	doneAsk := make(chan cr.Event, 1)
	rAsk.Start(ctx, cr.RuntimeRequest{
		Token:           tokAsk,
		NativeSessionID: recAsk.NativeSessionID,
		Plan:            cr.Plan{ID: "p-tp-ask", Payload: "hi"},
	}, func(e cr.Event) error {
		if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
			doneAsk <- e
		}
		return nil
	})
	if evAsk := <-doneAsk; evAsk.Kind != cr.EventCompleted {
		t.Fatalf("thirdParty ask turn = %+v", evAsk)
	}
}

func TestClaudeRuntimeSurfacesConcreteFailureDetails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX script fixture")
	}
	cases := []struct {
		mode     string
		wantText string
	}{
		{mode: "result-error", wantText: "upstream model quota exceeded"},
		{mode: "unknown-request", wantText: "unexpected_control_request"},
		{mode: "bad-mode", wantText: "bypassPermissions"},
	}
	for _, tc := range cases {
		t.Run(tc.mode, func(t *testing.T) {
			dir := t.TempDir()
			exe := filepath.Join(dir, "fake-claude")
			if err := os.WriteFile(exe, []byte(fakeClaudeThirdPartyAndFailureScript), 0o700); err != nil {
				t.Fatal(err)
			}
			cfgDir := filepath.Join(dir, "cfg")
			_ = os.MkdirAll(cfgDir, 0o700)
			convID := "conv-fail-" + tc.mode
			f := New(func(string) (Config, error) {
				return Config{
					Executable: exe,
					Cwd:        dir,
					ConfigDir:  cfgDir,
					Source:     "thirdParty",
					Model:      "maas/deepseek-v4.1-flash",
					ExtraEnv:   map[string]string{"FAKE_CLAUDE_MODE": tc.mode},
				}, nil
			})
			defer f.Release(convID)
			target, err := f.Target(convID)
			if err != nil {
				t.Fatal(err)
			}
			r := target.Runtime.(*Runtime)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			tok := cr.AttemptToken{ConversationID: convID, AttemptID: "a1", Generation: 1}
			rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
			if rec.Kind != cr.RecoveryNew {
				t.Fatalf("recover = %+v", rec)
			}
			done := make(chan cr.Event, 1)
			r.Start(ctx, cr.RuntimeRequest{
				Token:           tok,
				NativeSessionID: rec.NativeSessionID,
				Plan:            cr.Plan{ID: "p1", Payload: "hi"},
			}, func(e cr.Event) error {
				if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
					done <- e
				}
				return nil
			})
			ev := <-done
			if ev.Kind != cr.EventFailed {
				t.Fatalf("expected EventFailed, got %+v", ev)
			}
			if !strings.Contains(ev.Detail, tc.wantText) {
				t.Fatalf("expected Detail to contain %q, got %q", tc.wantText, ev.Detail)
			}
			if ev.Detail == "native turn failed/terminated without a validated success result; no automatic replay" {
				t.Fatalf("detail was replaced by generic opaque fallback: %q", ev.Detail)
			}
		})
	}
}
