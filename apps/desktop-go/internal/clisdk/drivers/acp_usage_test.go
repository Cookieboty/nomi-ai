package drivers

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestAcpMapperThoughtStreamingAndTruncation(t *testing.T) {
	m := NewAcpMapper()

	ev1 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"step 1 "}}`))
	if len(ev1) != 1 || ev1[0].Get("type") != "thinking" || ev1[0].Get("text") != "step 1 " {
		t.Fatalf("first thought chunk = %v", ev1)
	}
	ev2 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"step 2"}}`))
	if len(ev2) != 1 || ev2[0].Get("type") != "thinking" || ev2[0].Get("text") != "step 2" {
		t.Fatalf("second thought chunk = %v", ev2)
	}

	// Config/mode/usage/session-info updates must not reset thoughtLen before message text.
	if ev := m.Update(upd(t, `{"sessionUpdate":"config_option_update","configOptions":[]}`)); len(ev) != 0 {
		t.Fatalf("config_option_update should emit nothing, got %v", ev)
	}

	big := strings.Repeat("x", maxAcpThoughtLen+50)
	ev3 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"`+big+`"}}`))
	if len(ev3) != 1 {
		t.Fatalf("truncated thought chunk len = %d, want 1", len(ev3))
	}
	txt, _ := ev3[0].Get("text").(string)
	if !strings.HasSuffix(txt, "…") {
		t.Fatalf("expected truncated thinking text to end with ellipsis, len=%d", len(txt))
	}

	// Further thought chunks beyond maxAcpThoughtLen in the same segment are dropped.
	if ev4 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"overflow"}}`)); len(ev4) != 0 {
		t.Fatalf("overflow thought chunk must be dropped, got %v", ev4)
	}

	// Text chunk flushes thoughtLen without duplicating buffered thinking; next thinking segment works again.
	ev5 := m.Update(upd(t, `{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}`))
	if len(ev5) != 1 || ev5[0].Get("type") != "text-delta" || ev5[0].Get("text") != "hi" {
		t.Fatalf("message chunk = %v", ev5)
	}
	if flushed := m.Flush(); len(flushed) != 0 {
		t.Fatalf("Flush must not re-emit already streamed thinking: %v", flushed)
	}
	ev6 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"round 2"}}`))
	if len(ev6) != 1 || ev6[0].Get("text") != "round 2" {
		t.Fatalf("next thinking segment after reset = %v", ev6)
	}
}

func TestAcpMapperUsageModesAndSessionInfo(t *testing.T) {
	m := NewAcpMapper()

	evUsage := m.Update(upd(t, `{"sessionUpdate":"usage_update","used":0,"size":1000000,"cost":{"amount":0.025,"currency":"USD"}}`))
	if len(evUsage) != 1 {
		t.Fatalf("usage_update used=0 events = %d, want 1", len(evUsage))
	}
	if evUsage[0].Get("type") != "context" || evUsage[0].Get("tokens") != float64(0) || evUsage[0].Get("window") != float64(1000000) || evUsage[0].Get("costUsd") != 0.025 {
		t.Fatalf("usage_update event = %v", evUsage[0])
	}
	ctx := m.Context()
	if ctx.Get("contextTokens") != float64(0) || ctx.Get("contextWindow") != float64(1000000) || ctx.Get("costUsd") != 0.025 {
		t.Fatalf("mapper context = %v", ctx)
	}

	evMode := m.Update(upd(t, `{"sessionUpdate":"current_mode_update","currentModeId":"plan"}`))
	if len(evMode) != 1 || evMode[0].Get("type") != "status" || evMode[0].Get("permissionMode") != "plan" {
		t.Fatalf("current_mode_update = %v", evMode)
	}

	evInfo := m.Update(upd(t, `{"sessionUpdate":"session_info_update","title":"Test Conversation"}`))
	if len(evInfo) != 1 || evInfo[0].Get("type") != "session-info" || evInfo[0].Get("title") != "Test Conversation" {
		t.Fatalf("session_info_update = %v", evInfo)
	}
}

func TestAcpMapperPlanAndPlanUpdate(t *testing.T) {
	m := NewAcpMapper()
	// Plan updates must not reset the streaming thought budget.
	th1 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"`+strings.Repeat("a", maxAcpThoughtLen-5)+`"}}`))
	if len(th1) != 1 {
		t.Fatalf("thought 1 = %v", th1)
	}

	evPlan := m.Update(upd(t, `{
		"sessionUpdate":"plan",
		"planId":"p-main",
		"entries":[
			{"content":"Step 1","status":"done","priority":"HIGH"},
			{"title":"Step 2","status":"in-progress","priority":"medium"},
			{"step":"Step 3","status":"cancelled","priority":"unknown"},
			{"text":"Step 4","status":"error"},
			{"content":"   ","status":"pending"},
			{"content":"Step 5"}
		]
	}`))
	if len(evPlan) != 1 {
		t.Fatalf("plan events = %v", evPlan)
	}
	if evPlan[0].Get("type") != "plan" || evPlan[0].Get("planId") != "p-main" {
		t.Fatalf("plan meta = %v", evPlan[0])
	}
	entries, _ := evPlan[0].Get("entries").([]any)
	if len(entries) != 5 {
		t.Fatalf("entries len = %d, want 5 (%v)", len(entries), entries)
	}
	if entries[0].(*util.Obj).Get("status") != "completed" || entries[0].(*util.Obj).Get("priority") != "high" {
		t.Fatalf("entry 0 = %v", entries[0])
	}
	if entries[1].(*util.Obj).Get("content") != "Step 2" || entries[1].(*util.Obj).Get("status") != "in_progress" {
		t.Fatalf("entry 1 = %v", entries[1])
	}
	if entries[2].(*util.Obj).Get("status") != "skipped" || entries[2].(*util.Obj).Has("priority") {
		t.Fatalf("entry 2 = %v", entries[2])
	}
	if entries[3].(*util.Obj).Get("status") != "failed" || entries[4].(*util.Obj).Get("status") != "pending" {
		t.Fatalf("entry 3/4 = %v / %v", entries[3], entries[4])
	}

	// Thought budget was preserved across plan notification (only 5 chars left).
	th2 := m.Update(upd(t, `{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"1234567890"}}`))
	if len(th2) != 1 || th2[0].Get("text") != "12345…" {
		t.Fatalf("thought budget lost across plan: %v", th2)
	}

	// plan_update: items / markdown / file + empty plan ignored.
	evItems := m.Update(upd(t, `{"sessionUpdate":"plan_update","plan":{"type":"items","planId":"p-2","entries":[{"content":"Run tests","status":"active"}]}}`))
	if len(evItems) != 1 || evItems[0].Get("planId") != "p-2" {
		t.Fatalf("plan_update items = %v", evItems)
	}
	evMd := m.Update(upd(t, `{"sessionUpdate":"plan_update","plan":{"type":"markdown","planId":"p-md","content":"## Plan\n- A"}}`))
	if len(evMd) != 1 || evMd[0].Get("markdown") != "## Plan\n- A" {
		t.Fatalf("plan_update markdown = %v", evMd)
	}
	evFile := m.Update(upd(t, `{"sessionUpdate":"plan_update","plan":{"type":"file","planId":"p-file","uri":"file:///tmp/plan.md"}}`))
	if len(evFile) != 1 || evFile[0].Get("uri") != "file:///tmp/plan.md" {
		t.Fatalf("plan_update file = %v", evFile)
	}
	if evEmpty := m.Update(upd(t, `{"sessionUpdate":"plan","entries":[]}`)); len(evEmpty) != 0 {
		t.Fatalf("empty plan must emit nothing, got %v", evEmpty)
	}
}

func TestAcpDriverUsageAndNotifications(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		withUsage := true
		child.onLine = func(msg *util.Obj) {
			id := msg.Get("id")
			if id == nil {
				return
			}
			switch msg.Get("method") {
			case "initialize":
				child.send(O("jsonrpc", "2.0", "id", id, "result", O("protocolVersion", float64(1))))
			case "session/new":
				child.send(O("jsonrpc", "2.0", "id", id, "result", O(
					"sessionId", "s-1",
					"modes", O("currentModeId", "default"),
				)))
			case "session/prompt":
				if withUsage {
					child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
						"sessionId", "s-1",
						"update", O("sessionUpdate", "current_mode_update", "currentModeId", "bypassPermissions"),
					)))
					child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
						"sessionId", "s-1",
						"update", O("sessionUpdate", "config_option_update", "configOptions", []any{O("id", "model", "currentValue", "gemini-4-neon-medium")}),
					)))
					child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
						"sessionId", "s-1",
						"update", O("sessionUpdate", "session_info_update", "title", "Updated Title"),
					)))
					child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
						"sessionId", "s-1",
						"update", O("sessionUpdate", "usage_update", "used", float64(0), "size", float64(1000000)),
					)))
					child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
						"sessionId", "s-1",
						"update", O("sessionUpdate", "agent_message_chunk", "content", O("type", "text", "text", "ok")),
					)))
					child.send(O("jsonrpc", "2.0", "id", id, "result", O(
						"stopReason", "end_turn",
						"usage", O(
							"inputTokens", float64(120),
							"outputTokens", float64(45),
							"cachedReadTokens", float64(80),
							"cachedWriteTokens", float64(10),
							"thoughtTokens", float64(15),
							"totalTokens", float64(270),
						),
					)))
					return
				}
				child.send(O("jsonrpc", "2.0", "method", "session/update", "params", O(
					"sessionId", "s-1",
					"update", O("sessionUpdate", "agent_message_chunk", "content", O("type", "text", "text", "plain")),
				)))
				child.send(O("jsonrpc", "2.0", "id", id, "result", O("stopReason", "end_turn")))
			}
		}

		d := NewAcpDriver(AcpDriverOptions{Child: child})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatalf("Start: %v", err)
		}
		res1, err := jsrt.Await(d.Send(TurnInput{Text: "hi"}))
		if err != nil {
			t.Fatalf("Send 1: %v", err)
		}
		if d.ModeID == nil || *d.ModeID != "bypassPermissions" {
			t.Fatalf("ModeID = %v, want bypassPermissions", d.ModeID)
		}
		if d.SessionTitle != "Updated Title" {
			t.Fatalf("SessionTitle = %q, want Updated Title", d.SessionTitle)
		}
		if d.SessionRaw == nil || d.SessionRaw.Get("configOptions") == nil {
			t.Fatalf("configOptions not stored in SessionRaw")
		}
		u := util.AsObj(res1.Get("usage"))
		if u == nil || u.Get("inputTokens") != float64(120) || u.Get("outputTokens") != float64(45) ||
			u.Get("cacheReadTokens") != float64(80) || u.Get("cacheWriteTokens") != float64(10) ||
			u.Get("thoughtTokens") != float64(15) || u.Get("totalTokens") != float64(270) ||
			u.Get("contextTokens") != float64(0) || u.Get("contextWindow") != float64(1000000) {
			t.Fatalf("merged usage = %v", u)
		}

		// Turn without prompt usage or usage_update must omit usage key completely.
		withUsage = false
		res2, err := jsrt.Await(d.Send(TurnInput{Text: "hi2"}))
		if err != nil {
			t.Fatalf("Send 2: %v", err)
		}
		if res2.Has("usage") {
			t.Fatalf("unexpected usage key when none reported: %v", res2.Get("usage"))
		}
	})
}
