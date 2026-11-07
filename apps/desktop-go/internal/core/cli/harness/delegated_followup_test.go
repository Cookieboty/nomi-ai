package harness

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 委派标签空闲时用户接着对话：不算接手（结果照样回来源对话）；每轮的发起方记进 tab-finished
func TestDelegatedFollowUpOrigin(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	var origins []string
	jsrt.Run(func() {
		o.Events().On("tab-finished", func(v any) { origins = append(origins, v.(TabFinished).Origin) })
	})
	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "codex", "activate", false,
			"delegation", util.NewObj("goal", "g", "taskId", "task_9")))
	})
	id := str(tab, "id")
	// 程序发的一轮（委派自己）
	awaitSend(t, o, id, "do the thing")
	// 用户在子任务里接着说
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, "also add a test", nil, true) })
	if _, err := jsrt.Block(p); err != nil {
		t.Fatal(err)
	}
	// 沙箱授权后的「请继续」
	jsrt.Run(func() {
		if o.nextOrigin == nil {
			o.nextOrigin = map[string]string{}
		}
		o.nextOrigin[id] = "sandbox"
	})
	awaitSend(t, o, id, "continue")
	if len(origins) != 3 || origins[0] != "" || origins[1] != "user" || origins[2] != "sandbox" {
		t.Fatalf("origins = %q", origins)
	}
	if d := jsrt.Call(func() *util.Obj { return o.tab(id).Get("delegation").(*util.Obj) }); truthy(d.Get("takenOver")) {
		t.Fatal("an idle follow-up from the user is not a takeover")
	}
}
