package clisdk

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// interject（一轮进行中用户插入的消息）与 tool / thinking 一样是轨迹事件：打时间戳、进 buildTrace
func TestTraceKeepsInterject(t *testing.T) {
	ev := StampEvent(util.NewObj("type", "interject", "text", "also run tests", "textAt", 3.0), 42)
	if ev.Get("at") != 42.0 {
		t.Fatal(util.Stringify(ev))
	}
	out := BuildTrace([]Ev{util.NewObj("type", "text-delta", "text", "x"), ev})
	if len(out) != 1 || util.Stringify(out[0]) != `{"type":"interject","text":"also run tests","textAt":3,"at":42}` {
		t.Fatal(out)
	}
}

// 子代理的正文（agent-text）进轨迹；同一个子代理连续的几段合成一段
func TestTraceMergesAgentText(t *testing.T) {
	a := StampEvent(util.NewObj("type", "agent-text", "text", "第一段", "parentId", "c1"), 1)
	b := util.NewObj("type", "agent-text", "text", "第二段", "parentId", "c1", "at", 2.0)
	c := util.NewObj("type", "agent-text", "text", "别的", "parentId", "c2", "at", 3.0)
	out := BuildTrace([]Ev{a, b, c})
	if len(out) != 2 || out[0].Get("text") != "第一段\n\n第二段" || out[1].Get("parentId") != "c2" {
		t.Fatal(out)
	}
}

func TestTraceMergesPlanInPlace(t *testing.T) {
	p1 := StampEvent(util.NewObj("type", "plan", "planId", "p1", "textAt", 5.0,
		"entries", []any{util.NewObj("content", "Step 1", "status", "in_progress")}), 10)
	tool := StampEvent(util.NewObj("type", "tool", "name", "read_file", "status", "done", "detail", "t1", "textAt", 5.0), 11)
	p2 := StampEvent(util.NewObj("type", "plan", "planId", "p1", "textAt", 18.0,
		"entries", []any{util.NewObj("content", "Step 1", "status", "completed")}), 12)
	out := BuildTrace([]Ev{p1, tool, p2})
	if len(out) != 2 {
		t.Fatalf("len(out) = %d, want 2 (%v)", len(out), out)
	}
	if out[0].Get("type") != "plan" || out[0].Get("textAt") != 5.0 || out[0].Get("at") != 12.0 {
		t.Fatalf("merged plan = %v", out[0])
	}
	entries, _ := out[0].Get("entries").([]any)
	if len(entries) != 1 || entries[0].(*util.Obj).Get("status") != "completed" {
		t.Fatalf("merged entries = %v", entries)
	}
}

func TestTracePlanRemovedAndToolDedup(t *testing.T) {
	p1 := StampEvent(util.NewObj("type", "plan", "planId", "p-rm", "entries", []any{util.NewObj("content", "Step", "status", "pending")}), 10)
	t1 := StampEvent(util.NewObj("type", "tool", "name", "terminal", "status", "start", "detail", "term:1", "output", "a"), 11)
	t2 := StampEvent(util.NewObj("type", "tool", "name", "terminal", "status", "start", "detail", "term:1", "output", "ab"), 12)
	rm := StampEvent(util.NewObj("type", "plan-removed", "planId", "p-rm"), 13)
	out := BuildTrace([]Ev{p1, t1, t2, rm})
	if len(out) != 1 {
		t.Fatalf("len(out) = %d, want 1 (%v)", len(out), out)
	}
	if out[0].Get("type") != "tool" || out[0].Get("output") != "ab" {
		t.Fatalf("deduped tool = %v", out[0])
	}
}
