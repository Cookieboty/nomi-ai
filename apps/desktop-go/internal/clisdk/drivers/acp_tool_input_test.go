package drivers

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func upd(t *testing.T, s string) Json {
	t.Helper()
	v, err := util.ParseString(s)
	if err != nil {
		t.Fatal(err)
	}
	return v.(Json)
}

// Kimi Code 的顺序：第一段流式参数建 tool_call（只有工具名）→ 开始执行时 tool_call_update 补 rawInput → 做完只带结果。
// 做完的事件要带上中间那条的参数（之前被丢掉，命令显示成 {}）
func TestAcpToolInputFromInProgressUpdate(t *testing.T) {
	m := NewAcpMapper()
	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Bash","kind":"execute","status":"pending",
		"content":[{"type":"content","content":{"type":"text","text":"{\"comm"}}]}`))
	if ev := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"c1","title":"Bash","kind":"execute",
		"status":"in_progress","rawInput":{"command":"git diff --stat"}}`)); len(ev) != 0 {
		t.Fatalf("in-progress update must not emit: %v", ev)
	}
	out := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed",
		"content":[{"type":"content","content":{"type":"text","text":"3 files changed"}}]}`))
	if len(out) != 1 {
		t.Fatalf("done events = %d", len(out))
	}
	in, _ := out[0].Get("input").(string)
	if out[0].Get("status") != "done" || !strings.Contains(in, "git diff --stat") {
		t.Fatalf("done event = %v", out[0])
	}
	// 记下的参数做完就清掉
	if len(m.(*acpMapper).inputs) != 0 {
		t.Fatal("inputs not cleared after the call finished")
	}
}

// 只给标题和位置的（没有 rawInput）：照旧拼 description / path，做完的那条没带就用开始时的
func TestAcpToolInputTitleAndPathFallback(t *testing.T) {
	m := NewAcpMapper()
	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"r1","title":"Read","kind":"read","status":"pending",
		"locations":[{"path":"/p/a.go"}]}`))
	out := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"r1","status":"completed"}`))
	in, _ := out[0].Get("input").(string)
	if !strings.Contains(in, `"description":"Read"`) || !strings.Contains(in, `"path":"/p/a.go"`) {
		t.Fatalf("input = %s", in)
	}
}

func TestAcpToolOutputFromRawOutputAndContentPrecedence(t *testing.T) {
	m := NewAcpMapper()
	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"e1","name":"run_command","kind":"execute","status":"in_progress",
		"rawInput":{"CommandLine":"ls -la","toolSummary":"List files"}}`))
	out := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"e1","status":"completed",
		"rawOutput":{"output":"file1.csv\nfile2.csv"}}`))
	if len(out) != 1 {
		t.Fatalf("done events = %d", len(out))
	}
	if out[0].Get("name") != "run_shell_command" || out[0].Get("output") != "file1.csv\nfile2.csv" {
		t.Fatalf("event = %v", out[0])
	}

	// stdout/stderr 与纯字符串 rawOutput
	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"e2","kind":"execute","status":"in_progress","rawInput":{"CommandLine":"cmd2"}}`))
	out2 := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"e2","status":"completed",
		"rawOutput":{"stdout":"ok","stderr":"warn"}}`))
	if out2[0].Get("output") != "ok\nwarn" {
		t.Fatalf("stdout/stderr output = %v", out2[0].Get("output"))
	}

	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"e3","kind":"execute","status":"in_progress","rawInput":{"CommandLine":"cmd3"}}`))
	out3 := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"e3","status":"completed",
		"rawOutput":"plain text output"}`))
	if out3[0].Get("output") != "plain text output" {
		t.Fatalf("string rawOutput = %v", out3[0].Get("output"))
	}

	// 同时有 content 时优先使用 content
	m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"e4","kind":"execute","status":"in_progress","rawInput":{"CommandLine":"cmd4"}}`))
	out4 := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"e4","status":"completed",
		"content":[{"type":"content","content":{"type":"text","text":"from content"}}],
		"rawOutput":{"output":"from rawOutput"}}`))
	if out4[0].Get("output") != "from content" {
		t.Fatalf("content precedence failed: %v", out4[0].Get("output"))
	}
}

func TestAcpWriteFileNamePreserved(t *testing.T) {
	m := NewAcpMapper()
	startEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"w1","name":"write_file","kind":"edit","status":"in_progress",
		"title":"File scratch/a.py","rawInput":{"Path":"/tmp/a.py","Content":"print(1)"}}`))
	if len(startEvs) != 1 || startEvs[0].Get("name") != "write_file" {
		t.Fatalf("start event = %v", startEvs)
	}
	doneEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"w1","status":"completed","rawOutput":{}}`))
	if len(doneEvs) != 1 || doneEvs[0].Get("name") != "write_file" {
		t.Fatalf("done event = %v", doneEvs)
	}
	in, _ := doneEvs[0].Get("input").(string)
	if !strings.Contains(in, "/tmp/a.py") || !strings.Contains(in, "print(1)") {
		t.Fatalf("input = %s", in)
	}
}

func TestAcpUpdateStepsAndCancelledTool(t *testing.T) {
	m := NewAcpMapper()
	// update_steps（即使不含 name 字段）应映射为标准 plan 事件
	planEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"s1","kind":"other","status":"in_progress",
		"title":"update_steps","rawInput":{"steps":[{"title":"Analyze code","status":"completed"},{"title":"Run tests","status":"in_progress"}]}}`))
	if len(planEvs) != 1 || planEvs[0].Get("type") != "plan" || planEvs[0].Get("planId") != "steps" {
		t.Fatalf("update_steps plan event = %v", planEvs)
	}
	donePlanEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"s1","status":"completed"}`))
	if len(donePlanEvs) != 1 || donePlanEvs[0].Get("type") != "plan" || len(m.(*acpMapper).inputs) != 0 || len(m.(*acpMapper).names) != 0 {
		t.Fatalf("completed update_steps must clear mapper state: evs=%v inputs=%d names=%d", donePlanEvs, len(m.(*acpMapper).inputs), len(m.(*acpMapper).names))
	}

	// 普通工具 cancelled 应转为 error 并清理 mapper 状态
	startEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"c-cancel","kind":"execute","status":"in_progress",
		"title":"Run tests","rawInput":{"CommandLine":"go test ./..."}}`))
	if len(startEvs) != 1 || startEvs[0].Get("name") != "run_shell_command" || startEvs[0].Get("status") != "start" {
		t.Fatalf("start cancel tool = %v", startEvs)
	}
	doneEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"c-cancel","status":"cancelled"}`))
	if len(doneEvs) != 1 || doneEvs[0].Get("name") != "run_shell_command" || doneEvs[0].Get("status") != "error" {
		t.Fatalf("cancelled tool = %v", doneEvs)
	}
	if len(m.(*acpMapper).inputs) != 0 || len(m.(*acpMapper).names) != 0 {
		t.Fatalf("cancelled tool must clear mapper state")
	}
}

func TestAcpNamelessAgyToolsInference(t *testing.T) {
	m := NewAcpMapper()

	// update_focus (kind: other, title: "Update Focus", 无 name)
	fStart := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"f0","kind":"other","status":"in_progress",
		"title":"Update Focus","rawInput":{"focus":"Checking nameless ACP tools"}}`))
	if len(fStart) != 1 || fStart[0].Get("name") != "update_focus" {
		t.Fatalf("nameless update_focus = %v", fStart)
	}
	m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"f0","status":"completed"}`))

	// list_dir (kind: read, title: "Directory src", DirectoryPath)
	lStart := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"l0","kind":"read","status":"in_progress",
		"title":"Directory src","rawInput":{"DirectoryPath":"/repo/src"}}`))
	if len(lStart) != 1 || lStart[0].Get("name") != "list_dir" {
		t.Fatalf("nameless list_dir = %v", lStart)
	}
	m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"l0","status":"completed"}`))

	// search_web (kind: search, title: "... on Web")
	wStart := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"ws0","kind":"search","status":"in_progress",
		"title":"\"acp\" on Web","rawInput":{"query":"acp"}}`))
	if len(wStart) != 1 || wStart[0].Get("name") != "web_search" {
		t.Fatalf("nameless web_search = %v", wStart)
	}
	m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"ws0","status":"completed"}`))

	// write_file (kind: edit, 无 name, rawInput 只含 Path + Content)
	wfStart := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"wf0","kind":"edit","status":"in_progress",
		"title":"File a.go","rawInput":{"Path":"/repo/a.go","Content":"package a\n"}}`))
	if len(wfStart) != 1 || wfStart[0].Get("name") != "write_file" {
		t.Fatalf("nameless write_file = %v", wfStart)
	}
	m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"wf0","status":"completed"}`))

	// invoke_subagent (kind: other, 无 name, TypeName + Role + Prompt)
	saStart := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"sa0","kind":"other","status":"in_progress",
		"title":"Explorer","rawInput":{"TypeName":"research","Role":"Explorer","Prompt":"check protocol"}}`))
	if len(saStart) != 1 || saStart[0].Get("name") != "invoke_agent" {
		t.Fatalf("nameless invoke_agent = %v", saStart)
	}
	m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"sa0","status":"completed"}`))
}

func TestAcpTitlePreservedWithRawInputAndUpdateFocus(t *testing.T) {
	m := NewAcpMapper()
	// 1. tool_call 同时带 title 与 CommandLine：不应丢失 ACP title
	startEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"cmd1","name":"run_command","kind":"execute","status":"in_progress",
		"title":"Check repository status","rawInput":{"CommandLine":"git status"}}`))
	if len(startEvs) != 1 || startEvs[0].Get("title") != "Check repository status" {
		t.Fatalf("start command title = %v", startEvs)
	}
	doneEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"cmd1","status":"completed","rawOutput":{"output":"clean"}}`))
	if len(doneEvs) != 1 || doneEvs[0].Get("title") != "Check repository status" {
		t.Fatalf("done command title = %v", doneEvs)
	}

	// 2. update_focus 即使 kind 为 think 也必须保留 update_focus 工具名
	focusEvs := m.Update(upd(t, `{"sessionUpdate":"tool_call","toolCallId":"f1","name":"update_focus","kind":"think","status":"in_progress",
		"title":"Update Focus","rawInput":{"focus":"Inspecting ACP event pipeline"}}`))
	if len(focusEvs) != 1 || focusEvs[0].Get("name") != "update_focus" {
		t.Fatalf("update_focus name = %v", focusEvs)
	}
	focusDone := m.Update(upd(t, `{"sessionUpdate":"tool_call_update","toolCallId":"f1","status":"completed"}`))
	if len(focusDone) != 1 || focusDone[0].Get("name") != "update_focus" {
		t.Fatalf("update_focus done name = %v", focusDone)
	}
}
