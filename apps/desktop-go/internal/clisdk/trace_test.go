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
