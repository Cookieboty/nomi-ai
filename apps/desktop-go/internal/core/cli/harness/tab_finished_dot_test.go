package harness

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 跑完一轮要留一个「已完成」的点（侧栏行首），点进这个标签就消失；
// 失败 / 取消不留（失败有自己的红点）。
func TestFinishLeavesDoneDotUntilOpened(t *testing.T) {
	tmp := t.TempDir()
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"),
			LegacyDefaultCwd: filepath.Join(tmp, "docs"), Logger: nopLogger{}, Ports: nopPorts{}})
		defer o.Dispose()

		tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
		id := util.Str(tab.Get("id"))

		o.finish(o.tab(id), true, "done", nil)
		if !truthy(o.tab(id).Get("finished")) {
			t.Fatal("成功跑完一轮应该留一个完成点")
		}

		// 点开（即使它已经是当前标签）就等于看过了
		o.SetActiveTab(id)
		if truthy(o.tab(id).Get("finished")) {
			t.Fatal("进过会话后完成点应该消失")
		}
		if jsToNumber(o.tab(id).Get("unread")) != 0 {
			t.Fatal("进过会话后未读也应该清零")
		}

		// 失败不留完成点：上一次的标记要被清掉，不能挂着骗人
		o.finish(o.tab(id), true, "done", nil)
		e := "error_during_execution"
		o.finish(o.tab(id), false, "", &e)
		if truthy(o.tab(id).Get("finished")) {
			t.Fatal("失败不该留完成点")
		}
	})
}
