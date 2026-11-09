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
