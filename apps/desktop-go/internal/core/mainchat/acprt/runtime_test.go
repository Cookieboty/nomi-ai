package acprt

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

// TestHelperAcpProcess acts as an out-of-process ACP agent fixture when
// GO_ACP_HELPER_MODE is set. It avoids external runtime dependencies (python/node).
func TestHelperAcpProcess(t *testing.T) {
	mode := os.Getenv("GO_ACP_HELPER_MODE")
	if mode == "" {
		return
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1<<20), 4<<20)
	var mu sync.Mutex
	send := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		b, _ := json.Marshal(v)
		fmt.Println(string(b))
	}
	counter := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var req struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal([]byte(line), &req) != nil {
			continue
		}
		switch req.Method {
		case "initialize":
			if mode == "init_fail" {
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "init refused"}})
				continue
			}
			loadCap := mode != "no_load_cap"
			send(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion":   1,
					"agentCapabilities": map[string]any{"loadSession": loadCap},
				},
			})
		case "session/load":
			sid, _ := req.Params["sessionId"].(string)
			switch mode {
			case "ok", "approval_allow", "approval_deny", "trace", "cancel_hang":
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": sid, "modes": map[string]any{"currentModeId": "default", "availableModes": []any{map[string]any{"id": "default"}}}}})
			case "missing":
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32602, "message": "session not found"}})
			case "load_unknown":
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "corrupted db"}})
			case "hang":
				// Intentionally do not respond.
			}
		case "session/new":
			if mode == "new_refused" {
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "Authentication required"}})
				continue
			}
			counter++
			availModes := []any{map[string]any{"id": "default"}}
			if mode == "set_mode_grok" {
				availModes = []any{
					map[string]any{"id": "default"},
					map[string]any{"id": "acceptEdits"},
					map[string]any{"id": "bypassPermissions"},
					map[string]any{"id": "plan"},
				}
			}
			send(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]any{"sessionId": fmt.Sprintf("acp-sess-%d", counter), "modes": map[string]any{"currentModeId": "default", "availableModes": availModes}},
			})
		case "session/set_mode":
			if logPath := os.Getenv("GO_ACP_SET_MODE_LOG"); logPath != "" {
				modeID, _ := req.Params["modeId"].(string)
				_ = os.WriteFile(logPath, []byte(modeID), 0o600)
			}
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/set_model", "session/set_config_option":
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/prompt":
			sid, _ := req.Params["sessionId"].(string)
			switch mode {
			case "trace":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tc-1", "kind": "read", "title": "Read file", "status": "in_progress"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "kind": "read", "title": "Read file", "status": "completed"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "traced ok"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			case "approval_allow", "approval_deny":
				permMode := mode
				go func(promptID any) {
					permReq := map[string]any{
						"jsonrpc": "2.0",
						"id":      "srv-perm-1",
						"method":  "session/request_permission",
						"params": map[string]any{
							"sessionId": sid,
							"toolCall":  map[string]any{"toolCallId": "tc-p", "title": "Read secret"},
							"options":   []any{map[string]any{"optionId": "allow-once", "kind": "allow_once", "name": "Allow"}, map[string]any{"optionId": "deny-once", "kind": "reject_once", "name": "Deny"}},
						},
					}
					send(permReq)
					_ = permMode
					// Handled below via incoming response line.
					_ = promptID
				}(req.ID)
				// Wait for the permission response in the main loop and finish prompt.
				for sc.Scan() {
					respLine := strings.TrimSpace(sc.Text())
					if respLine == "" {
						continue
					}
					var resp struct {
						ID     any            `json:"id"`
						Result map[string]any `json:"result"`
					}
					if json.Unmarshal([]byte(respLine), &resp) == nil && resp.ID == "srv-perm-1" {
						outObj, _ := resp.Result["outcome"].(map[string]any)
						optID, _ := outObj["optionId"].(string)
						if optID == "allow-once" {
							send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "approved answer"}}}})
							send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
						} else {
							send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "refusal"}})
						}
						break
					}
				}
			case "cancel_hang":
				// Sleep until killed by host process group termination.
				time.Sleep(10 * time.Second)
			default:
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "hello from acp"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			}
		}
	}
	os.Exit(0)
}

func newHelperRuntime(t *testing.T, backendID, mode string) (*Runtime, func()) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell wrapper fixture")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_ACP_HELPER_MODE", mode)
	dir := t.TempDir()
	proj := filepath.Join(dir, "proj")
	cfg := filepath.Join(dir, "cfg")
	for _, d := range []string{proj, cfg} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// Copy test binary path via symlink is valid across OS; override args only in test helper:
	// pass -test.run=^TestHelperAcpProcess$ via config check in test by wrapping via helper env.
	// Since builtin.AcpArgs returns ["--acp"], standard Go test binary ignores unknown flags only if
	// invoked directly with helper wrapper, so on non-windows we wrap in a one-line shell script
	// or run test binary wrapper. Let's create a tiny wrapper script / batch file cleanly.
	wrapper := filepath.Join(dir, "acp-cli")
	script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
	if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	f := New(backendID, func(string) (Config, error) {
		return Config{BackendID: backendID, Executable: wrapper, Cwd: proj, ConfigDir: cfg}, nil
	})
	target, err := f.Target("conv")
	if err != nil {
		t.Fatal(err)
	}
	return target.Runtime.(*Runtime), func() { f.Release("conv") }
}

func TestRecoverClassification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	token := cr.AttemptToken{ConversationID: "conv", AttemptID: "a1", Generation: 1}
	cases := []struct {
		mode string
		prev cr.Binding
		want cr.RecoveryKind
		sid  string
	}{
		{"ok", cr.Binding{}, cr.RecoveryNew, "acp-sess-1"},
		{"ok", cr.Binding{ID: "b1", NativeSessionID: "old-sid"}, cr.RecoveryResumed, "old-sid"},
		{"missing", cr.Binding{ID: "b1", NativeSessionID: "old-sid"}, cr.RecoveryFallback, "acp-sess-1"},
		{"load_unknown", cr.Binding{ID: "b1", NativeSessionID: "old-sid"}, cr.RecoveryUnknown, ""},
		{"no_load_cap", cr.Binding{ID: "b1", NativeSessionID: "old-sid"}, cr.RecoveryUnknown, ""},
		{"hang", cr.Binding{ID: "b1", NativeSessionID: "old-sid"}, cr.RecoveryUnknown, ""},
		{"new_refused", cr.Binding{}, cr.RecoveryError, ""},
		{"init_fail", cr.Binding{}, cr.RecoveryError, ""},
	}
	for _, c := range cases {
		t.Run(c.mode+"_"+string(c.want), func(t *testing.T) {
			r, release := newHelperRuntime(t, "gemini", c.mode)
			defer release()
			cctx := ctx
			if c.mode == "hang" {
				var cancel2 context.CancelFunc
				cctx, cancel2 = context.WithTimeout(ctx, 300*time.Millisecond)
				defer cancel2()
			}
			got := r.Recover(cctx, cr.RecoveryRequest{Token: token, Previous: c.prev})
			if got.Kind != c.want {
				t.Fatalf("mode %s: got %s (%s), want %s", c.mode, got.Kind, got.Detail, c.want)
			}
			if c.sid != "" && got.NativeSessionID != c.sid {
				t.Fatalf("mode %s: sid=%q, want %q", c.mode, got.NativeSessionID, c.sid)
			}
		})
	}
}

func TestStartTraceApprovalAndCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	t.Run("trace_and_text", func(t *testing.T) {
		r, release := newHelperRuntime(t, "grok", "trace")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "t1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}
		var mu sync.Mutex
		var events []cr.Event
		done := make(chan struct{})
		sub := r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p1", Payload: "hello"},
		}, func(e cr.Event) error {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				close(done)
			}
			return nil
		})
		if sub.Kind != cr.SubmitAccepted {
			t.Fatalf("submit=%+v", sub)
		}
		<-done
		var sawTrace, sawText, sawCompleted bool
		for _, e := range events {
			if e.Kind == cr.EventTrace && e.Trace != nil && e.Trace.Tool == "read_file" {
				sawTrace = true
			}
			if e.Kind == cr.EventText && e.Text == "traced ok" {
				sawText = true
			}
			if e.Kind == cr.EventCompleted {
				sawCompleted = true
			}
		}
		if !sawTrace || !sawText || !sawCompleted {
			t.Fatalf("trace=%v text=%v completed=%v events=%+v", sawTrace, sawText, sawCompleted, events)
		}
	})

	t.Run("approval_allow", func(t *testing.T) {
		r, release := newHelperRuntime(t, "kimi", "approval_allow")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "t2", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}
		done := make(chan cr.Event, 1)
		var text string
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p2", Payload: "need perm"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventApproval {
				go func(id string) {
					_ = r.Approve(ctx, cr.ApprovalDecision{
						Token:           tok,
						NativeSessionID: rec.NativeSessionID,
						ApprovalID:      id,
						Allow:           true,
					})
				}(e.ApprovalID)
			}
			if e.Kind == cr.EventText {
				text = e.Text
			}
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted || text != "approved answer" {
			t.Fatalf("last=%+v text=%q", last, text)
		}
	})

	t.Run("cancel_kills_process_group", func(t *testing.T) {
		r, release := newHelperRuntime(t, "minimax", "cancel_hang")
		defer release()
		tok := cr.AttemptToken{ConversationID: "conv", AttemptID: "t3", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}
		tctx, tcancel := context.WithCancel(ctx)
		defer tcancel()
		done := make(chan struct{})
		r.Start(tctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p3", Payload: "hang"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				close(done)
			}
			return nil
		})
		tcancel()
		res := r.Cancel(ctx, tok)
		if res.Kind != cr.CancelStopped {
			t.Fatalf("cancel=%+v", res)
		}
		<-done
	})

	t.Run("set_mode_from_permission_mode", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("POSIX shell wrapper fixture")
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		proj := filepath.Join(dir, "proj")
		cfg := filepath.Join(dir, "cfg")
		logPath := filepath.Join(dir, "set_mode.txt")
		for _, d := range []string{proj, cfg} {
			if err := os.MkdirAll(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("GO_ACP_HELPER_MODE", "set_mode_grok")
		t.Setenv("GO_ACP_SET_MODE_LOG", logPath)
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		f := New("grok", func(string) (Config, error) {
			return Config{BackendID: "grok", Executable: wrapper, Cwd: proj, ConfigDir: cfg, PermissionMode: "auto"}, nil
		})
		defer f.Release("conv-mode")
		target, err := f.Target("conv-mode")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		tok := cr.AttemptToken{ConversationID: "conv-mode", AttemptID: "t4", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}
		done := make(chan cr.Event, 1)
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p4", Payload: "hello"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted {
			t.Fatalf("last=%+v", last)
		}
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatalf("expected session/set_mode to be invoked: %v", err)
		}
		if string(raw) != "acceptEdits" {
			t.Fatalf("session/set_mode modeId = %q, want acceptEdits", string(raw))
		}
	})
}
