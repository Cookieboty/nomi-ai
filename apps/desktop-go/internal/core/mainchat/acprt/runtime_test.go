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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
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
		if rpcLog := os.Getenv("GO_ACP_RPC_LOG"); rpcLog != "" {
			if f, err := os.OpenFile(rpcLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
				_, _ = f.WriteString(line + "\n")
				_ = f.Close()
			}
		}
		switch req.Method {
		case "initialize":
			if mode == "init_fail" {
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32000, "message": "init refused"}})
				continue
			}
			loadCap := mode != "no_load_cap"
			agentCaps := map[string]any{"loadSession": loadCap}
			if mode == "agy_compliance" {
				agentCaps["sessionCapabilities"] = map[string]any{"close": map[string]any{}}
			}
			send(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion":   1,
					"agentCapabilities": agentCaps,
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
			res := map[string]any{"sessionId": fmt.Sprintf("acp-sess-%d", counter), "modes": map[string]any{"currentModeId": "default", "availableModes": availModes}}
			if mode == "grok_unknown_accept_edits" {
				res["modes"] = map[string]any{"currentModeId": "agent"}
			} else if mode == "plan_rejected" {
				res["modes"] = map[string]any{"currentModeId": "default"}
			}
			if mode == "title_and_config_model" {
				res["title"] = "Handshake Title"
				res["configOptions"] = []any{
					map[string]any{"id": "cfg_model", "category": "model", "currentValue": "custom-config-model"},
				}
			}
			if mode == "stream_agy" {
				res["models"] = map[string]any{
					"currentModelId": "auto",
					"availableModels": []any{
						map[string]any{"modelId": "auto", "name": "Auto"},
						map[string]any{"modelId": "gemini-4-neon-medium", "name": "Gemini 4 Neon (Medium)"},
						map[string]any{"modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)"},
					},
				}
			}
			send(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  res,
			})
		case "session/set_mode":
			modeID, _ := req.Params["modeId"].(string)
			if logPath := os.Getenv("GO_ACP_SET_MODE_LOG"); logPath != "" {
				if os.Getenv("GO_ACP_SET_MODE_APPEND") == "1" {
					f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
					if f != nil {
						_, _ = f.WriteString(modeID + "\n")
						_ = f.Close()
					}
				} else {
					_ = os.WriteFile(logPath, []byte(modeID), 0o600)
				}
			}
			if (mode == "grok_unknown_accept_edits" && modeID == "acceptEdits") || (mode == "plan_rejected" && modeID == "plan") {
				send(map[string]any{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error": map[string]any{
						"code":    -32602,
						"message": "Invalid params: unknown mode id: " + modeID,
					},
				})
				continue
			}
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/set_model":
			if logPath := os.Getenv("GO_ACP_SET_MODEL_LOG"); logPath != "" {
				modelID, _ := req.Params["modelId"].(string)
				f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
				if f != nil {
					_, _ = f.WriteString(modelID + "\n")
					_ = f.Close()
				}
			}
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/set_config_option":
			if logPath := os.Getenv("GO_ACP_SET_CONFIG_LOG"); logPath != "" {
				cfgID, _ := req.Params["configId"].(string)
				val := fmt.Sprint(req.Params["value"])
				f, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
				if f != nil {
					_, _ = f.WriteString(cfgID + "=" + val + "\n")
					_ = f.Close()
				}
			}
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
		case "session/prompt":
			sid, _ := req.Params["sessionId"].(string)
			switch mode {
			case "grok_unknown_accept_edits":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "grok fallback ok"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			case "stream_generic":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "usage_update", "used": float64(50), "size": float64(128000)}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "generic think"}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "generic ok"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": float64(42), "outputTokens": float64(8)}}})
			case "title_and_config_model":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "session_info_update", "title": "In-Turn Native Title"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "title answer"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn", "model": "actual-server-model"}})
				time.Sleep(40 * time.Millisecond)
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "session_info_update", "title": "Post-Turn Async Title"}}})
			case "stream_agy":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "usage_update", "used": float64(0), "size": float64(1000000)}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "plan "}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "step"}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tc-s1", "kind": "read", "title": "Read file", "status": "in_progress"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tc-s1", "kind": "read", "title": "Read file", "status": "completed", "content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "file body"}}}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "part1 "}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "part2"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn", "usage": map[string]any{"inputTokens": float64(100), "outputTokens": float64(50), "cachedReadTokens": float64(40), "thoughtTokens": float64(10), "totalTokens": float64(200)}}})
			case "trace":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "tc-1", "kind": "read", "title": "Read file", "status": "in_progress"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "kind": "read", "title": "Read file", "status": "completed"}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "traced ok"}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
			case "plan_agy":
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "Intro "}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "plan", "planId": "main", "entries": []any{map[string]any{"content": "Step A", "status": "in_progress"}}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "body"}}}})
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "plan", "planId": "main", "entries": []any{map[string]any{"content": "Step A", "status": "completed"}}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"stopReason": "end_turn"}})
				time.Sleep(40 * time.Millisecond)
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "plan", "planId": "main", "entries": []any{map[string]any{"content": "Late", "status": "completed"}}}}})
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
		case "session/close":
			send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
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

	t.Run("streaming_thinking_usage_and_warm_effort_sync", func(t *testing.T) {
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
		logPath := filepath.Join(dir, "set_model.txt")
		for _, d := range []string{proj, cfg} {
			if err := os.MkdirAll(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("GO_ACP_HELPER_MODE", "stream_agy")
		t.Setenv("GO_ACP_SET_MODEL_LOG", logPath)
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		effort := "medium"
		f := New("antigravity", func(string) (Config, error) {
			return Config{
				BackendID:  "antigravity",
				Executable: wrapper,
				Cwd:        proj,
				ConfigDir:  cfg,
				Source:     "local",
				Model:      "gemini-4-neon",
				Effort:     effort,
			}, nil
		})
		defer f.Release("conv-stream")

		target, err := f.Target("conv-stream")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		tok1 := cr.AttemptToken{ConversationID: "conv-stream", AttemptID: "s1", Generation: 1}
		rec1 := r.Recover(ctx, cr.RecoveryRequest{Token: tok1})
		if rec1.Kind != cr.RecoveryNew {
			t.Fatalf("recover1=%+v", rec1)
		}

		var evs []cr.Event
		done := make(chan cr.Event, 1)
		var mu sync.Mutex
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok1,
			NativeSessionID: rec1.NativeSessionID,
			Plan:            cr.Plan{ID: "p-s1", Payload: "hello"},
		}, func(e cr.Event) error {
			mu.Lock()
			evs = append(evs, e)
			mu.Unlock()
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted {
			t.Fatalf("last=%+v", last)
		}
		if last.Model != "gemini-4-neon-medium" || last.Effort != "medium" {
			t.Fatalf("completed model/effort = %q/%q, want gemini-4-neon-medium/medium", last.Model, last.Effort)
		}
		if last.Usage == nil || last.Usage.InputTokens == nil || *last.Usage.InputTokens != 100 ||
			last.Usage.OutputTokens == nil || *last.Usage.OutputTokens != 50 ||
			last.Usage.CacheReadTokens == nil || *last.Usage.CacheReadTokens != 40 ||
			last.Usage.ThoughtTokens == nil || *last.Usage.ThoughtTokens != 10 ||
			last.Usage.TotalTokens == nil || *last.Usage.TotalTokens != 200 ||
			last.Usage.ContextTokens == nil || *last.Usage.ContextTokens != 0 ||
			last.Usage.ContextWindow == nil || *last.Usage.ContextWindow != 1000000 {
			t.Fatalf("completed usage = %+v", last.Usage)
		}

		var streamThinking, streamText, toolOut string
		var sawStreamBeforeText bool
		sawTextEvent := false
		for _, e := range evs {
			switch e.Kind {
			case cr.EventStream:
				if !sawTextEvent {
					sawStreamBeforeText = true
				}
				streamThinking += e.Thinking
				streamText += e.Text
			case cr.EventTrace:
				if e.Trace != nil && e.Trace.Output != "" {
					toolOut = e.Trace.Output
				}
			case cr.EventText:
				sawTextEvent = true
			}
		}
		if !sawStreamBeforeText || streamThinking != "plan step" || streamText != "part1 part2" || toolOut != "file body" {
			t.Fatalf("stream/trace check failed: beforeText=%v thinking=%q text=%q toolOut=%q", sawStreamBeforeText, streamThinking, streamText, toolOut)
		}

		// Warm reuse changing ONLY Effort must sync new suffixed model in place on the same session/process.
		effort = "high"
		target2, err := f.Target("conv-stream")
		if err != nil {
			t.Fatal(err)
		}
		if target2.Runtime != r {
			t.Fatalf("expected same cached Runtime instance on effort-only change")
		}
		tok2 := cr.AttemptToken{ConversationID: "conv-stream", AttemptID: "s2", Generation: 2}
		rec2 := r.Recover(ctx, cr.RecoveryRequest{
			Token:    tok2,
			Previous: cr.Binding{ID: "b1", NativeSessionID: rec1.NativeSessionID, Status: cr.StatusLive},
		})
		if rec2.Kind != cr.RecoveryResumed || rec2.NativeSessionID != rec1.NativeSessionID {
			t.Fatalf("warm effort-change recover=%+v", rec2)
		}
		rawModels, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Fields(string(rawModels))
		if len(lines) != 2 || lines[0] != "gemini-4-neon-medium" || lines[1] != "gemini-4-neon-high" {
			t.Fatalf("session/set_model sequence = %v, want [gemini-4-neon-medium gemini-4-neon-high]", lines)
		}
	})

	t.Run("generic_acp_standard_model_and_streaming", func(t *testing.T) {
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
		modelLog := filepath.Join(dir, "set_model.txt")
		cfgLog := filepath.Join(dir, "set_config.txt")
		for _, d := range []string{proj, cfg} {
			if err := os.MkdirAll(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("GO_ACP_HELPER_MODE", "stream_generic")
		t.Setenv("GO_ACP_SET_MODEL_LOG", modelLog)
		t.Setenv("GO_ACP_SET_CONFIG_LOG", cfgLog)
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		f := New("grok", func(string) (Config, error) {
			return Config{
				BackendID:  "grok",
				Executable: wrapper,
				Cwd:        proj,
				ConfigDir:  cfg,
				Source:     "local",
				Model:      "grok-4",
				Effort:     "high",
			}, nil
		})
		defer f.Release("conv-generic")

		target, err := f.Target("conv-generic")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		tok := cr.AttemptToken{ConversationID: "conv-generic", AttemptID: "g1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}

		var streamThinking, streamText string
		done := make(chan cr.Event, 1)
		var mu sync.Mutex
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p-g1", Payload: "hello"},
		}, func(e cr.Event) error {
			mu.Lock()
			if e.Kind == cr.EventStream {
				streamThinking += e.Thinking
				streamText += e.Text
			}
			mu.Unlock()
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted {
			t.Fatalf("last=%+v", last)
		}
		if last.Model != "grok-4" || last.Effort != "high" {
			t.Fatalf("completed model/effort = %q/%q, want grok-4/high", last.Model, last.Effort)
		}
		if streamThinking != "generic think" || streamText != "generic ok" {
			t.Fatalf("stream = %q / %q", streamThinking, streamText)
		}
		if last.Usage == nil || last.Usage.InputTokens == nil || *last.Usage.InputTokens != 42 ||
			last.Usage.OutputTokens == nil || *last.Usage.OutputTokens != 8 ||
			last.Usage.ContextTokens == nil || *last.Usage.ContextTokens != 50 ||
			last.Usage.ContextWindow == nil || *last.Usage.ContextWindow != 128000 {
			t.Fatalf("usage = %+v", last.Usage)
		}
		rawM, _ := os.ReadFile(modelLog)
		rawC, _ := os.ReadFile(cfgLog)
		if strings.TrimSpace(string(rawM)) != "grok-4" || strings.TrimSpace(string(rawC)) != "reasoning_effort=high" {
			t.Fatalf("standard ACP model/config calls = %q / %q", string(rawM), string(rawC))
		}
	})

	t.Run("title_updates_and_config_option_response_model", func(t *testing.T) {
		r, release := newHelperRuntime(t, "gemini", "title_and_config_model")
		defer release()
		var tmu sync.Mutex
		var titles []string
		r.SetTitleHandler(func(title string) {
			tmu.Lock()
			titles = append(titles, title)
			tmu.Unlock()
		})
		tok := cr.AttemptToken{ConversationID: "conv-title", AttemptID: "t-title-1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec)
		}
		done := make(chan cr.Event, 1)
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p-title-1", Payload: "hello"},
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
		if last.Model != "custom-config-model" || last.ResponseModel != "actual-server-model" {
			t.Fatalf("completed model/responseModel = %q / %q", last.Model, last.ResponseModel)
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			tmu.Lock()
			joined := strings.Join(titles, "|")
			tmu.Unlock()
			if strings.Contains(joined, "Handshake Title") &&
				strings.Contains(joined, "In-Turn Native Title") &&
				strings.Contains(joined, "Post-Turn Async Title") {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		tmu.Lock()
		gotTitles := strings.Join(titles, "|")
		tmu.Unlock()
		if !strings.Contains(gotTitles, "Handshake Title") ||
			!strings.Contains(gotTitles, "In-Turn Native Title") ||
			!strings.Contains(gotTitles, "Post-Turn Async Title") {
			t.Fatalf("expected handshake, in-turn, and post-turn titles, got %v", titles)
		}
		// Post-turn session_info_update must keep worker healthy (no failure).
		jsErr := ""
		func() {
			tok2 := cr.AttemptToken{ConversationID: "conv-title", AttemptID: "t-title-2", Generation: 2}
			rec2 := r.Recover(ctx, cr.RecoveryRequest{
				Token:    tok2,
				Previous: cr.Binding{ID: "b1", NativeSessionID: rec.NativeSessionID, Status: cr.StatusLive},
			})
			if rec2.Kind != cr.RecoveryResumed {
				jsErr = rec2.Detail
			}
		}()
		if jsErr != "" {
			t.Fatalf("post-turn title poisoned warm worker: %s", jsErr)
		}
	})

	t.Run("grok_unknown_mode_id_falls_back_to_default_and_remembers", func(t *testing.T) {
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
		t.Setenv("GO_ACP_HELPER_MODE", "grok_unknown_accept_edits")
		t.Setenv("GO_ACP_SET_MODE_LOG", logPath)
		t.Setenv("GO_ACP_SET_MODE_APPEND", "1")
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		effort := "medium"
		f := New("grok", func(string) (Config, error) {
			return Config{BackendID: "grok", Executable: wrapper, Cwd: proj, ConfigDir: cfg, PermissionMode: "auto", Effort: effort}, nil
		})
		defer f.Release("conv-grok-fallback")
		target, err := f.Target("conv-grok-fallback")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		tok1 := cr.AttemptToken{ConversationID: "conv-grok-fallback", AttemptID: "gf1", Generation: 1}
		rec1 := r.Recover(ctx, cr.RecoveryRequest{Token: tok1})
		if rec1.Kind != cr.RecoveryNew || rec1.NativeSessionID == "" {
			t.Fatalf("recover1 = %+v, want RecoveryNew", rec1)
		}
		done := make(chan cr.Event, 1)
		var text string
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok1,
			NativeSessionID: rec1.NativeSessionID,
			Plan:            cr.Plan{ID: "p-gf1", Payload: "翻译俄罗斯语言"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventText {
				text = e.Text
			}
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted || text != "grok fallback ok" {
			t.Fatalf("turn1 = %+v text=%q", last, text)
		}
		// 热复用且触发 applySessionSettings：不应再重发已被拒绝的 acceptEdits
		effort = "high"
		target2, err := f.Target("conv-grok-fallback")
		if err != nil {
			t.Fatal(err)
		}
		r2 := target2.Runtime.(*Runtime)
		tok2 := cr.AttemptToken{ConversationID: "conv-grok-fallback", AttemptID: "gf2", Generation: 2}
		rec2 := r2.Recover(ctx, cr.RecoveryRequest{
			Token:    tok2,
			Previous: cr.Binding{ID: "b1", NativeSessionID: rec1.NativeSessionID, Status: cr.StatusLive},
		})
		if rec2.Kind != cr.RecoveryResumed {
			t.Fatalf("warm recover2 = %+v, want RecoveryResumed", rec2)
		}
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Fields(string(raw))
		if len(lines) != 2 || lines[0] != "acceptEdits" || lines[1] != "default" {
			t.Fatalf("session/set_mode sequence = %v, want [acceptEdits default]", lines)
		}
	})

	t.Run("plan_mode_never_falls_back_when_rejected", func(t *testing.T) {
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
		t.Setenv("GO_ACP_HELPER_MODE", "plan_rejected")
		t.Setenv("GO_ACP_SET_MODE_LOG", logPath)
		t.Setenv("GO_ACP_SET_MODE_APPEND", "1")
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		f := New("grok", func(string) (Config, error) {
			return Config{BackendID: "grok", Executable: wrapper, Cwd: proj, ConfigDir: cfg, PermissionMode: "deny"}, nil
		})
		defer f.Release("conv-plan-reject")
		target, err := f.Target("conv-plan-reject")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		tok := cr.AttemptToken{ConversationID: "conv-plan-reject", AttemptID: "pr1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok})
		if rec.Kind != cr.RecoveryError || !strings.Contains(rec.Detail, "unknown mode id: plan") {
			t.Fatalf("plan reject recover = %+v, want RecoveryError with unknown mode id: plan", rec)
		}
		raw, err := os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Fields(string(raw))
		if len(lines) != 1 || lines[0] != "plan" {
			t.Fatalf("plan reject must not fall back to default, got %v", lines)
		}
	})

	t.Run("antigravity_compliance_init_verbatim_reject_handoff_and_close", func(t *testing.T) {
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
		rpcLog := filepath.Join(dir, "rpc.log")
		for _, d := range []string{proj, cfg} {
			if err := os.MkdirAll(d, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("GO_ACP_HELPER_MODE", "agy_compliance")
		t.Setenv("GO_ACP_RPC_LOG", rpcLog)
		wrapper := filepath.Join(dir, "acp-cli")
		script := fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestHelperAcpProcess$\n", exe)
		if err := os.WriteFile(wrapper, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}

		f := New("antigravity", func(string) (Config, error) {
			return Config{BackendID: "antigravity", Executable: wrapper, Cwd: proj, ConfigDir: cfg}, nil
		})
		target, err := f.Target("conv-agy-comp")
		if err != nil {
			t.Fatal(err)
		}
		r := target.Runtime.(*Runtime)
		if caps := r.Capabilities(); !strings.Contains(caps.Bridges.Memory.Detail, "cross-model context replay is disabled") {
			t.Fatalf("antigravity Bridges.Memory.Detail = %q, want cross-model replay disabled notice", caps.Bridges.Memory.Detail)
		}

		tok1 := cr.AttemptToken{ConversationID: "conv-agy-comp", AttemptID: "ac1", Generation: 1}
		rec := r.Recover(ctx, cr.RecoveryRequest{Token: tok1})
		if rec.Kind != cr.RecoveryNew || rec.NativeSessionID == "" {
			t.Fatalf("recover = %+v, want RecoveryNew", rec)
		}
		if !cli.DetectLocalLogin("antigravity", "") {
			t.Fatal("DetectLocalLogin(\"antigravity\", \"\") must become true after session/new")
		}

		// Non-empty Handoff must be rejected without sending prompt.
		subH := r.Start(ctx, cr.RuntimeRequest{
			Token:           cr.AttemptToken{ConversationID: "conv-agy-comp", AttemptID: "ac_h", Generation: 1},
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p-h", RequestBody: "raw", Handoff: "<handoff>prior</handoff>", Payload: "<handoff>prior</handoff>\n\nraw"},
		}, func(cr.Event) error { return nil })
		if subH.Kind != cr.SubmitNotSent {
			t.Fatalf("antigravity Start with handoff = %+v, want SubmitNotSent", subH)
		}

		// Without Handoff, RequestBody must be forwarded verbatim instead of wrapped Payload.
		done := make(chan cr.Event, 1)
		exactBody := "exact user prompt verbatim"
		subOk := r.Start(ctx, cr.RuntimeRequest{
			Token:           tok1,
			NativeSessionID: rec.NativeSessionID,
			Plan:            cr.Plan{ID: "p-raw", RequestBody: exactBody, Payload: "WRAPPED_PAYLOAD_MUST_NOT_BE_SENT"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		if subOk.Kind != cr.SubmitAccepted {
			t.Fatalf("antigravity Start verbatim = %+v, want SubmitAccepted", subOk)
		}
		if last := <-done; last.Kind != cr.EventCompleted {
			t.Fatalf("turn completed = %+v", last)
		}

		// Releasing triggers close() -> session/close.
		f.Release("conv-agy-comp")

		raw, err := os.ReadFile(rpcLog)
		if err != nil {
			t.Fatal(err)
		}
		var sawInit, sawPrompt, sawClose bool
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if line == "" {
				continue
			}
			var msg map[string]any
			if json.Unmarshal([]byte(line), &msg) != nil {
				continue
			}
			params, _ := msg["params"].(map[string]any)
			switch msg["method"] {
			case "initialize":
				sawInit = true
				ci, _ := params["clientInfo"].(map[string]any)
				if ci == nil || ci["name"] != "nomi" {
					t.Fatalf("initialize missing clientInfo.name=nomi: %s", line)
				}
				cc, _ := params["clientCapabilities"].(map[string]any)
				if cc == nil || cc["terminal"] != false {
					t.Fatalf("initialize missing clientCapabilities.terminal=false: %s", line)
				}
			case "session/prompt":
				sawPrompt = true
				blocks, _ := params["prompt"].([]any)
				if len(blocks) != 1 {
					t.Fatalf("prompt blocks = %v, want 1", blocks)
				}
				b0, _ := blocks[0].(map[string]any)
				if b0["text"] != exactBody {
					t.Fatalf("session/prompt text = %q, want exact RequestBody %q", b0["text"], exactBody)
				}
			case "session/close":
				sawClose = true
			}
		}
		if !sawInit || !sawPrompt || !sawClose {
			t.Fatalf("missing expected ACP calls (init=%v prompt=%v close=%v):\n%s", sawInit, sawPrompt, sawClose, string(raw))
		}
	})

	t.Run("agy_plan_stream_merge_textAt_and_late_plan", func(t *testing.T) {
		r, release := newHelperRuntime(t, "antigravity", "plan_agy")
		defer release()
		tok1 := cr.AttemptToken{ConversationID: "conv-plan-agy", AttemptID: "pa1", Generation: 1}
		rec1 := r.Recover(ctx, cr.RecoveryRequest{Token: tok1})
		if rec1.Kind != cr.RecoveryNew {
			t.Fatalf("recover=%+v", rec1)
		}
		done := make(chan cr.Event, 1)
		var mu sync.Mutex
		var planTraces []*cr.TraceEntry
		r.Start(ctx, cr.RuntimeRequest{
			Token:           tok1,
			NativeSessionID: rec1.NativeSessionID,
			Plan:            cr.Plan{ID: "p-agy-1", RequestBody: "do plan"},
		}, func(e cr.Event) error {
			if e.Kind == cr.EventTrace && e.Trace != nil && e.Trace.Kind == "plan" {
				mu.Lock()
				planTraces = append(planTraces, e.Trace)
				mu.Unlock()
			}
			if e.Kind == cr.EventCompleted || e.Kind == cr.EventFailed {
				done <- e
			}
			return nil
		})
		last := <-done
		if last.Kind != cr.EventCompleted {
			t.Fatalf("last=%+v", last)
		}
		mu.Lock()
		gotTraces := append([]*cr.TraceEntry(nil), planTraces...)
		mu.Unlock()
		if len(gotTraces) != 2 {
			t.Fatalf("planTraces len = %d, want 2", len(gotTraces))
		}
		if gotTraces[0].ID != "plan:main" || gotTraces[0].TextAt == nil || *gotTraces[0].TextAt != len("Intro ") {
			t.Fatalf("planTraces[0] = %+v", gotTraces[0])
		}
		if gotTraces[1].ID != "plan:main" || gotTraces[1].TextAt == nil || *gotTraces[1].TextAt != len("Intro body") {
			t.Fatalf("planTraces[1] = %+v", gotTraces[1])
		}
		// Post-turn late plan update must keep warm worker alive.
		time.Sleep(80 * time.Millisecond)
		tok2 := cr.AttemptToken{ConversationID: "conv-plan-agy", AttemptID: "pa2", Generation: 2}
		rec2 := r.Recover(ctx, cr.RecoveryRequest{
			Token:    tok2,
			Previous: cr.Binding{ID: "b1", NativeSessionID: rec1.NativeSessionID, Status: cr.StatusLive},
		})
		if rec2.Kind != cr.RecoveryResumed {
			t.Fatalf("late plan poisoned warm worker: %+v", rec2)
		}
	})
}
