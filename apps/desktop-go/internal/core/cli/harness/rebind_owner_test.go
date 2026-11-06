package harness

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// #269：两个任务都在标签属于 prev 时挑中它，只有先改写的那个能领到；不带 expectTaskId 的旧调用照旧
func TestRebindDelegationChecksExpectedOwner(t *testing.T) {
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"),
			LegacyDefaultCwd: filepath.Join(tmp, "docs"), Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
		defer o.Dispose()
		tab := o.CreateTab(util.NewObj("backend", "codex", "activate", false,
			"delegation", util.NewObj("goal", "x", "taskId", "prev")))
		id := util.Str(tab.Get("id"))
		d, _ := o.tab(id).Get("delegation").(*util.Obj)
		if d == nil || d.Get("by") != "nomi" || o.tab(id).Get("status") != "idle" {
			t.Fatalf("setup: %s", util.Stringify(o.tab(id)))
		}
		owner := func() string { d, _ := o.tab(id).Get("delegation").(*util.Obj); return util.Str(d.Get("taskId")) }
		if !o.RebindDelegation(id, util.NewObj("goal", "a", "taskId", "A", "expectTaskId", "prev")) || owner() != "A" {
			t.Fatal("A should claim the tab")
		}
		if o.RebindDelegation(id, util.NewObj("goal", "b", "taskId", "B", "expectTaskId", "prev")) || owner() != "A" {
			t.Fatalf("B saw a stale owner and must not overwrite A (owner %q)", owner())
		}
		// A 在发出前取消：下一个任务看到的拥有者是 A，照常复用（不会一直被占着）
		if !o.RebindDelegation(id, util.NewObj("goal", "c", "taskId", "C", "expectTaskId", "A")) || owner() != "C" {
			t.Fatal("C should reuse the tab")
		}
		if !o.RebindDelegation(id, util.NewObj("goal", "d", "taskId", "D")) || owner() != "D" {
			t.Fatal("rebind without an expected owner keeps working")
		}
	})
}
