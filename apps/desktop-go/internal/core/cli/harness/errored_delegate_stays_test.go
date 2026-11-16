package harness

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 出错 / 被停下的委派标签和 2.3.16 一样留着、能接着回复：标签不关、仍属于原任务、原生会话保留（只拆常驻进程，下次发消息续接）
func TestErroredDelegatedTabStaysOpenAndResumable(t *testing.T) {
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"),
			LegacyDefaultCwd: filepath.Join(tmp, "docs"), Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
		defer o.Dispose()
		for _, errStr := range []string{"error_during_execution", "stopped"} {
			tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false,
				"delegation", util.NewObj("goal", "x", "taskId", "T-"+errStr)))
			id := util.Str(tab.Get("id"))
			o.tab(id).Set("cliSessionId", "sess_"+errStr)
			e := errStr
			o.finish(o.tab(id), false, "", &e)
			if !o.RecoverDelegatedTab(id, false) {
				t.Fatalf("%s: recover should succeed on an idle tab", errStr)
			}
			if !o.tabs.Has(id) || o.tab(id).Get("status") != "idle" {
				t.Fatalf("%s: errored delegated tab must stay open and idle", errStr)
			}
			if o.tab(id).Get("cliSessionId") != "sess_"+errStr || !o.dormant[id] {
				t.Fatalf("%s: session must be kept for the next reply, got %v", errStr, o.tab(id).Get("cliSessionId"))
			}
			d, _ := o.tab(id).Get("delegation").(*util.Obj)
			if d == nil || util.Str(d.Get("taskId")) != "T-"+errStr {
				t.Fatalf("%s: tab must still belong to its own task", errStr)
			}
		}
	})
}
