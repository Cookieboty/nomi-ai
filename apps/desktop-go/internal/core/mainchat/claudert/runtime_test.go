package claudert

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
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
            out({'type': 'assistant', 'session_id': sid, 'message': {'content': [{'type': 'text', 'text': 'hello'}]}})
            out({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': sid, 'result': 'hello'})
            time.sleep(0.05)
            out({'type': 'summary', 'session_id': sid, 'summary': 'Claude Post-Turn Summary'})
        else:
            out({'type': 'unexpected_unknown_event', 'session_id': sid})
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
