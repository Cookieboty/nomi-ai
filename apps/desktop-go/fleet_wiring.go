package main

import (
	"os"
	"runtime"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/fleet"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// wireFleet：Agent 看板。标签从编排器取（进 GIL），任务从持续任务服务取（GIL 外），
// 标签 / 任务变化时推 fleet.changed。
func wireFleet(router *contract.Router, ts *tasks.Service) func() {
	o := harnessOrch
	s := fleet.New(fleet.Deps{
		SelfPid:   os.Getpid(),
		Cores:     runtime.NumCPU(),
		TotalMem:  func() float64 { return float64(local.TotalMem()) },
		ReadProcs: func() *agents.ProcTable { return agents.ReadProcTable(usage.Platform()) },
		Tabs: func() []fleet.Tab {
			if o == nil {
				return nil
			}
			return jsrt.Call(func() []fleet.Tab {
				out := []fleet.Tab{}
				arr, _ := o.ListTabs().Get("tabs").([]any)
				for _, x := range arr {
					if t, ok := x.(*util.Obj); ok {
						out = append(out, fleetTab(t, o.TabPids, o.PendingPermissions))
					}
				}
				return out
			})
		},
		Tasks: func() []tasks.Task {
			if ts == nil {
				return nil
			}
			return ts.Runtime.List()
		},
		Emit: func(st fleet.State) { router.Emit("fleet.changed", st) },
	})
	var offTasks func()
	if ts != nil {
		offTasks = ts.OnChange(func(string) { s.Changed() })
	}
	if o != nil {
		jsrt.Run(func() { o.Events().On("tabs", func(any) { s.Changed() }) })
	}
	codinghandlers.RegisterFleet(router, func() codinghandlers.Fleet { return s })
	return func() {
		if offTasks != nil {
			offTasks()
		}
		s.Close()
	}
}

// fleetTab：ListTabs 的一项 → 看板的标签信息
func fleetTab(t *util.Obj, pids func(string) []int, perms func(string) int) fleet.Tab {
	str := func(o *util.Obj, k string) string { v, _ := o.Get(k).(string); return v }
	num := func(o *util.Obj, k string) int64 { v, _ := o.Get(k).(float64); return int64(v) }
	id := str(t, "id")
	ft := fleet.Tab{ID: id, Title: str(t, "title"), Backend: str(t, "backend"), Cwd: str(t, "cwd"), Status: str(t, "status"),
		HasSession: str(t, "cliSessionId") != "", UpdatedAt: num(t, "updatedAt"), Pids: pids(id), PendingPerms: perms(id)}
	if sp, ok := t.Get("sandboxPending").([]any); ok {
		ft.SandboxPending = len(sp)
	}
	if d, ok := t.Get("delegation").(*util.Obj); ok && d.Get("by") == "nomi" && d.Get("takenOver") != true {
		ft.Delegated, ft.CallID, ft.TaskID = true, str(d, "callId"), str(d, "taskId")
	}
	return ft
}
