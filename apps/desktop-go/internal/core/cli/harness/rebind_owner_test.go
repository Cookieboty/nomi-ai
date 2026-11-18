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
		if !o.RebindDelegation(id, util.NewObj("title", "Nomi · 认领 A", "goal", "a", "callId", "call-A", "taskId", "A", "expectTaskId", "prev")) || owner() != "A" {
			t.Fatal("A should claim the tab")
		}
		dA, _ := o.tab(id).Get("delegation").(*util.Obj)
		if prevTasks, _ := dA.Get("prevTaskIds").([]any); len(prevTasks) != 1 || prevTasks[0] != "prev" {
			t.Fatalf("prevTaskIds = %v, want [prev]", prevTasks)
		}
		if gotTitle := util.Str(o.tab(id).Get("title")); gotTitle != "Nomi · 认领 A" {
			t.Fatalf("rebound tab title = %q, want Nomi · 认领 A", gotTitle)
		}
		if o.RebindDelegation(id, util.NewObj("goal", "b", "taskId", "B", "expectTaskId", "prev")) || owner() != "A" {
			t.Fatalf("B saw a stale owner and must not overwrite A (owner %q)", owner())
		}
		// A 在发出前取消：下一个任务看到的拥有者是 A，照常复用（不会一直被占着）
		if !o.RebindDelegation(id, util.NewObj("goal", "c", "callId", "call-C", "taskId", "C", "expectTaskId", "A")) || owner() != "C" {
			t.Fatal("C should reuse the tab")
		}
		dC, _ := o.tab(id).Get("delegation").(*util.Obj)
		if prevCalls, _ := dC.Get("prevCallIds").([]any); len(prevCalls) != 1 || prevCalls[0] != "call-A" {
			t.Fatalf("prevCallIds = %v, want [call-A]", prevCalls)
		}
		if prevTasks, _ := dC.Get("prevTaskIds").([]any); len(prevTasks) != 2 || prevTasks[0] != "prev" || prevTasks[1] != "A" {
			t.Fatalf("prevTaskIds = %v, want [prev A]", prevTasks)
		}
		if !o.RebindDelegation(id, util.NewObj("goal", "d", "taskId", "D")) || owner() != "D" {
			t.Fatal("rebind without an expected owner keeps working")
		}
		// 出错的委派标签不再被 RebindDelegation 复用；RecoverDelegatedTab 可丢弃损坏会话并结转上下文
		errStr := "error_during_execution"
		o.tab(id).Set("cliSessionId", "bad_sess")
		o.finish(o.tab(id), false, "", &errStr)
		if o.RebindDelegation(id, util.NewObj("goal", "e", "taskId", "E", "expectTaskId", "D")) {
			t.Fatal("errored tab must not be rebound to a new delegation")
		}
		if !o.RecoverDelegatedTab(id, true) || o.tab(id).Get("cliSessionId") != nil {
			t.Fatalf("RecoverDelegatedTab(dropSession=true) should clear cliSessionId, got %v", o.tab(id).Get("cliSessionId"))
		}
	})
}
