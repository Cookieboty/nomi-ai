package drivers

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestAcpMapperFullSessionUpdates(t *testing.T) {
	m := NewAcpMapper()

	// 1. user_message_chunk & user_message (text buffers quietly; image attachment emits user-message)
	if ev := m.Update(upd(t, `{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello "}}`)); len(ev) != 0 {
		t.Fatalf("user_message_chunk text must not emit: %v", ev)
	}
	if ev := m.Update(upd(t, `{"sessionUpdate":"user_message","content":[{"type":"text","text":"world"},{"type":"image","mimeType":"image/png","data":"AA=="}]}`)); len(ev) != 1 || ev[0].Get("type") != "user-message" || ev[0].Get("text") != "hello world" {
		t.Fatalf("user_message with image = %v", ev)
	}

	// 2. agent_message & agent_thought messageId deduplication (incremental delta)
	t1 := m.Update(upd(t, `{"sessionUpdate":"agent_thought","messageId":"th-1","content":{"type":"text","text":"step 1"}}`))
	if len(t1) != 1 || t1[0].Get("type") != "thinking" || t1[0].Get("text") != "step 1" {
		t.Fatalf("agent_thought 1 = %v", t1)
	}
	t2 := m.Update(upd(t, `{"sessionUpdate":"agent_thought","messageId":"th-1","content":{"type":"text","text":"step 1 + step 2"}}`))
	if len(t2) != 1 || t2[0].Get("text") != " + step 2" {
		t.Fatalf("agent_thought 2 incremental = %v", t2)
	}

	m1 := m.Update(upd(t, `{"sessionUpdate":"agent_message","messageId":"m-1","content":{"type":"text","text":"Hello"}}`))
	if len(m1) != 1 || m1[0].Get("type") != "text-delta" || m1[0].Get("text") != "Hello" {
		t.Fatalf("agent_message 1 = %v", m1)
	}
	m2 := m.Update(upd(t, `{"sessionUpdate":"agent_message","messageId":"m-1","content":{"type":"text","text":"Hello ACP"}}`))
	if len(m2) != 1 || m2[0].Get("type") != "text-delta" || m2[0].Get("text") != " ACP" {
		t.Fatalf("agent_message 2 incremental = %v", m2)
	}

	// 3. resource_link scheme filtering + resource + audio
	rl := m.Update(upd(t, `{"sessionUpdate":"agent_message_chunk","content":[
		{"type":"resource_link","name":"Doc","uri":"https://example.com/doc","mimeType":"text/markdown"},
		{"type":"resource_link","name":"Bad","uri":"javascript:alert(1)"},
		{"type":"resource","resource":{"uri":"file:///tmp/a.go","mimeType":"text/x-go","text":"package main"}},
		{"type":"audio","mimeType":"audio/mp3"}
	]}`))
	if len(rl) != 1 {
		t.Fatalf("content blocks event len = %d, want 1 (%v)", len(rl), rl)
	}
	txt, _ := rl[0].Get("text").(string)
	if !strings.Contains(txt, "https://example.com/doc") {
		t.Fatalf("missing safe resource_link: %q", txt)
	}
	if strings.Contains(txt, "](javascript:") || !strings.Contains(txt, "`Bad (javascript:alert(1))`") {
		t.Fatalf("unsafe scheme javascript: must not render clickable link: %q", txt)
	}
	if !strings.Contains(txt, "package main") || !strings.Contains(txt, "audio/mp3") {
		t.Fatalf("missing resource or audio block: %q", txt)
	}

	// 4. plan_removed
	pr := m.Update(upd(t, `{"sessionUpdate":"plan_removed","planId":"p-old"}`))
	if len(pr) != 1 || pr[0].Get("type") != "plan-removed" || pr[0].Get("planId") != "p-old" {
		t.Fatalf("plan_removed = %v", pr)
	}

	// 5. tool_call -> tool_call_content_chunk -> in-progress tool_call_update -> completed with unified diff & terminal
	if ev := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"tc-1","kind":"edit","name":"edit_file","status":"in_progress","rawInput":{"file_path":"a.go"}}`)); len(ev) != 1 || ev[0].Get("status") != "start" {
		t.Fatalf("tool_call start = %v", ev)
	}
	chunkEv := m.Update(upd(t, `{"sessionUpdate":"tool_call_content_chunk","toolCallId":"tc-1","delta":"partial chunk"}`))
	if len(chunkEv) != 1 || chunkEv[0].Get("status") != "start" || chunkEv[0].Get("output") != "partial chunk" {
		t.Fatalf("tool_call_content_chunk = %v", chunkEv)
	}
	ipOut := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"in_progress","content":[{"type":"diff","path":"a.go","oldText":"old","newText":"new"}]}`))
	if len(ipOut) != 1 || ipOut[0].Get("status") != "start" {
		t.Fatalf("in_progress tool_call_update with diff output = %v", ipOut)
	}
	ipStr, _ := ipOut[0].Get("output").(string)
	if !strings.Contains(ipStr, "--- a.go") || !strings.Contains(ipStr, "-old") || !strings.Contains(ipStr, "+new") {
		t.Fatalf("unified diff missing in output: %q", ipStr)
	}
	doneOut := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"tc-1","status":"completed","content":[{"type":"terminal","terminalId":"term-9","command":"go test","exitCode":0,"output":"PASS"}]}`))
	if len(doneOut) != 1 || doneOut[0].Get("status") != "done" || !strings.Contains(strQ(doneOut[0].Get("output")), "$ go test (exit 0)\nPASS") {
		t.Fatalf("completed tool with terminal block = %v", doneOut)
	}

	// 6. terminal_update & terminal_output_chunk
	tc1 := m.Update(upd(t, `{"sessionUpdate":"terminal_output_chunk","terminalId":"t1","command":"npm test","chunk":"line1"}`))
	if len(tc1) != 1 || tc1[0].Get("name") != "terminal" || tc1[0].Get("status") != "start" || tc1[0].Get("output") != "line1" {
		t.Fatalf("terminal_output_chunk = %v", tc1)
	}
	tu := m.Update(upd(t, `{"sessionUpdate":"terminal_update","terminalId":"t1","status":"completed","exitCode":1}`))
	if len(tu) != 1 || tu[0].Get("name") != "terminal" || tu[0].Get("status") != "error" || tu[0].Get("output") != "line1" {
		t.Fatalf("terminal_update nonzero exit = %v", tu)
	}

	// 7. compaction_update
	if ev := m.Update(upd(t, `{"sessionUpdate":"compaction_update","status":"started"}`)); len(ev) != 1 || ev[0].Get("type") != "status" || ev[0].Get("kind") != "compact" {
		t.Fatalf("compaction started = %v", ev)
	}
	if ev := m.Update(upd(t, `{"sessionUpdate":"compaction_update","status":"completed","tokensAfter":4096}`)); len(ev) != 2 || ev[0].Get("kind") != "clear" || ev[1].Get("type") != "context" || ev[1].Get("tokens") != float64(4096) {
		t.Fatalf("compaction completed = %v", ev)
	}

	// 8. notice & state_update
	if ev := m.Update(upd(t, `{"sessionUpdate":"notice","level":"warn","text":"rate limit near"}`)); len(ev) != 1 || ev[0].Get("type") != "notice" || ev[0].Get("tag") != "warn" || ev[0].Get("text") != "rate limit near" {
		t.Fatalf("notice = %v", ev)
	}
	if ev := m.Update(upd(t, `{"sessionUpdate":"state_update","state":"working","message":"Indexing repo"}`)); len(ev) != 1 || ev[0].Get("type") != "status" || ev[0].Get("kind") != "working" || ev[0].Get("text") != "Indexing repo" {
		t.Fatalf("state_update working = %v", ev)
	}
	if ev := m.Update(upd(t, `{"sessionUpdate":"state_update","state":"idle"}`)); len(ev) != 1 || ev[0].Get("type") != "status" || ev[0].Get("kind") != "clear" {
		t.Fatalf("state_update idle = %v", ev)
	}

	// 9. config_option_update with effective model/effort vs empty array (already verified in acp_usage_test)
	cfgEv := m.Update(upd(t, `{"sessionUpdate":"config_option_update","configOptions":[
		{"id":"model","category":"model","currentValue":"claude-sonnet-4"},
		{"id":"reasoning_effort","category":"thought_level","currentValue":"high"}
	]}`))
	if len(cfgEv) != 1 || cfgEv[0].Get("type") != "config-update" || cfgEv[0].Get("model") != "claude-sonnet-4" || cfgEv[0].Get("effort") != "high" {
		t.Fatalf("config_option_update = %v", cfgEv)
	}

	// 10. subagent_update (start -> progress -> end) & session_message_chunk / session_message
	sa1 := m.Update(upd(t, `{"sessionUpdate":"subagent_update","subagentId":"sub-1","toolCallId":"call-9","label":"Explorer","agentType":"research","status":"running","progress":"Scanning"}`))
	if len(sa1) != 1 || sa1[0].Get("type") != "agent" || sa1[0].Get("op") != "start" || sa1[0].Get("callId") != "call-9" {
		t.Fatalf("subagent_update start = %v", sa1)
	}
	sa2 := m.Update(upd(t, `{"sessionUpdate":"subagent_update","subagentId":"sub-1","status":"completed","summary":"Found 3 matches","usage":{"toolUses":2,"tokens":500,"durationMs":120}}`))
	if len(sa2) != 1 || sa2[0].Get("op") != "end" || sa2[0].Get("status") != "completed" || util.AsObj(sa2[0].Get("usage")).Get("tokens") != float64(500) {
		t.Fatalf("subagent_update end = %v", sa2)
	}
	smc := m.Update(upd(t, `{"sessionUpdate":"session_message_chunk","sessionId":"call-9","messageId":"sm-1","content":{"type":"text","text":"sub chunk"}}`))
	if len(smc) != 1 || smc[0].Get("type") != "agent-text-delta" || smc[0].Get("parentId") != "call-9" || smc[0].Get("itemId") != "sm-1" {
		t.Fatalf("session_message_chunk = %v", smc)
	}
	sm := m.Update(upd(t, `{"sessionUpdate":"session_message","sessionId":"call-9","messageId":"sm-1","content":{"type":"text","text":"sub final"}}`))
	if len(sm) != 1 || sm[0].Get("type") != "agent-text" || sm[0].Get("parentId") != "call-9" || sm[0].Get("text") != "sub final" {
		t.Fatalf("session_message = %v", sm)
	}
}

func TestAcpDriverCommandsListResumeAndPermissionOptionID(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		var permOutcomeOption string
		var sawMethods []string
		child.onLine = func(msg *util.Obj) {
			id := msg.Get("id")
			if id == nil {
				return
			}
			method, _ := msg.Get("method").(string)
			sawMethods = append(sawMethods, method)
			switch method {
			case "initialize":
				child.send(O("jsonrpc", "2.0", "id", id, "result", O(
					"protocolVersion", float64(1),
					"agentCapabilities", O(
						"loadSession", true,
						"sessionCapabilities", O(
							"resume", O(),
							"list", O(),
						),
					),
				)))
			case "session/load":
				// Fail session/load to verify fallback to session/resume.
				child.send(O("jsonrpc", "2.0", "id", id, "error", O("code", float64(-32601), "message", "not implemented")))
			case "session/resume":
				sid := strQ(getp(msg.Get("params"), "sessionId"))
				child.send(O("jsonrpc", "2.0", "id", id, "result", O("sessionId", sid, "modes", O("currentModeId", "default"))))
				child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
					"sessionId", sid,
					"update", O(
						"sessionUpdate", "available_commands_update",
						"availableCommands", []any{
							O("name", "review", "description", "Review changes", "input", O("hint", "[file]")),
						},
					),
				)))
			case "session/list":
				child.send(O("jsonrpc", "2.0", "id", id, "result", O(
					"sessions", []any{
						O("sessionId", "s-old-1", "cwd", "/w", "title", "Old Chat", "updatedAt", float64(12345)),
					},
					"nextCursor", "cur-2",
				)))
			case "session/prompt":
				child.send(O("jsonrpc", "2.0", "id", "srv-p1", "method", "session/request_permission", "params", O(
					"sessionId", "s-prev",
					"toolCall", O("toolCallId", "tc-9", "title", "Run script", "rawInput", O("cmd", "echo ok")),
					"options", []any{
						O("optionId", "opt-once", "kind", "allow_once", "name", "Allow once"),
						O("optionId", "opt-always", "kind", "allow_always", "name", "Always allow"),
					},
				)))
				// Wait for response in a tiny goroutine so onLine isn't blocked.
				prevOnLine := child.onLine
				child.onLine = func(resp *util.Obj) {
					if resp.Get("id") == "srv-p1" {
						permOutcomeOption = strQ(getp(getp(resp.Get("result"), "outcome"), "optionId"))
						child.onLine = prevOnLine
						child.send(O("jsonrpc", "2.0", "id", id, "result", O("stopReason", "end_turn")))
						return
					}
					if prevOnLine != nil {
						prevOnLine(resp)
					}
				}
			}
		}

		d := NewAcpDriver(AcpDriverOptions{Child: child})
		var gotCommands bool
		var gotPermOptions int
		var permID string
		d.On(func(ev SessionEvent) {
			if ev == nil {
				return
			}
			if ev.Get("kind") == "commands" {
				if arr, ok := ev.Get("commands").([]any); ok && len(arr) == 1 {
					gotCommands = true
				}
			}
			if ev.Get("kind") == "permission" {
				permID, _ = ev.Get("id").(string)
				req := util.AsObj(ev.Get("request"))
				if opts, ok := req.Get("options").([]any); ok {
					gotPermOptions = len(opts)
				}
				if strQ(req.Get("toolName")) != "Run script" || !strings.Contains(strQ(req.Get("argsPreview")), "echo ok") {
					t.Fatalf("permission request metadata = %v", req)
				}
				d.RespondPermission(permID, O("decision", "allow", "optionId", "opt-always"))
			}
		})

		prev := "s-prev"
		startRes, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w", ResumeID: &prev}))
		if err != nil {
			t.Fatalf("Start with fallback resume: %v", err)
		}
		if startRes.Get("resumed") != true || startRes.Get("sessionId") != "s-prev" {
			t.Fatalf("startRes = %v", startRes)
		}
		if !d.SupportsResumeSession() || !d.SupportsListSessions() {
			t.Fatalf("expected SupportsResumeSession && SupportsListSessions true")
		}
		if len(d.AvailableCommands) != 1 || !gotCommands {
			t.Fatalf("AvailableCommands = %v, gotCommands=%v", d.AvailableCommands, gotCommands)
		}

		listRes, err := jsrt.Await(d.ListSessions("/w", "", nil))
		if err != nil {
			t.Fatalf("ListSessions: %v", err)
		}
		sessions, _ := listRes.Get("sessions").([]any)
		if len(sessions) != 1 || listRes.Get("nextCursor") != "cur-2" {
			t.Fatalf("ListSessions result = %v", listRes)
		}

		if _, err := jsrt.Await(d.Send(TurnInput{Text: "run"})); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if gotPermOptions != 2 || permOutcomeOption != "opt-always" {
			t.Fatalf("gotPermOptions=%d permOutcomeOption=%q", gotPermOptions, permOutcomeOption)
		}
	})
}
