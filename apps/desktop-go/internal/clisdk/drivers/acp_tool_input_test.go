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
