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
