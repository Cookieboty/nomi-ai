package main

import (
	"os"
	"path/filepath"
	"runtime"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/airouter"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/fleet"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// wireFleet：Agent 看板。标签从编排器取（进 GIL），任务从持续任务服务取（GIL 外），
// 标签 / 任务变化时推 fleet.changed。
func wireFleet(router *contract.Router, userData string, ts *tasks.Service, chats *airouter.Handlers) func() {
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
				frozen := o.FrozenTabs()
				arr, _ := o.ListTabs().Get("tabs").([]any)
				for _, x := range arr {
					if t, ok := x.(*util.Obj); ok {
						ft := fleetTab(t, o.TabPids, o.PendingPermissions)
						if f, ok := frozen[ft.ID]; ok {
							ft.Paused = &fleet.Paused{By: f.By, At: f.At.UnixMilli()}
						}
						// 已完成卡片上的总结：没在跑的才取（第一次会读一次消息文件，之后在内存里）
						if ft.HasSession && ft.Status != "running" && ft.Status != "queued" {
							ft.Summary = o.LastReply(ft.ID)
						}
						out = append(out, ft)
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
		TaskSummary: func(id string) string {
			if ts == nil {
				return ""
			}
			rec := ts.Runtime.Get(id)
			if rec == nil {
				return ""
			}
			for i := len(rec.Attempts) - 1; i >= 0; i-- {
				if r := rec.Attempts[i].Result; r != nil && r.Summary != "" {
					return r.Summary
				}
			}
			return ""
		},
		Chats: func() []fleet.Chat {
			if chats == nil {
				return nil
			}
			out := []fleet.Chat{}
			for _, c := range chats.ActiveChats() {
				out = append(out, fleet.Chat{ConversationID: c.ConversationID, StartedAt: c.StartedAt.UnixMilli()})
			}
			return out
		},
		External: func() ([]fleet.ExtSession, map[float64]string) {
			if agentsSvc == nil {
				return nil, nil
			}
			type res struct {
				s   []fleet.ExtSession
				cwd map[float64]string
			}
			r := jsrt.Call(func() res {
				return res{fleetExternal(agentsSvc.State()), agentsSvc.ProcCwds()}
			})
			return r.s, r.cwd
		},
		Emit: func(st fleet.State) { router.Emit("fleet.changed", st) },
		// 只给用户手动关闭空闲的外部编程助手进程用（fleet.closeIdle）
		Kill: nodeproc.KillPid,
		// 内存守护：只动编排器里的标签（纳管的）
		Pressure:     agents.SystemMemory,
		SettingsPath: filepath.Join(userData, "fleet", "settings.json"),
		Freeze: func(id string, pids []int, by string) bool {
			if o == nil {
				return false
			}
			return jsrt.Call(func() bool { return o.FreezeTab(id, pids, by) })
		},
		Thaw: func(id string) bool {
			if o == nil {
				return false
			}
			return jsrt.Call(func() bool { return o.ThawTab(id) })
		},
		ReclaimIdle: func() []string {
			if o == nil {
				return nil
			}
			return jsrt.Call(func() []string { return o.ReclaimIdleNow() })
		},
	})
	var offTasks func()
	if ts != nil {
		offTasks = ts.OnChange(func(string) { s.Changed() })
	}
	if chats != nil {
		chats.OnActiveChange(s.Changed)
	}
	jsrt.Run(func() {
		if o != nil {
			o.Events().On("tabs", func(any) { s.Changed() })
		}
		onAgentsChanged = s.Changed
	})
	codinghandlers.RegisterFleet(router, func() codinghandlers.Fleet { return s })
	s.Start()
	return func() {
		if offTasks != nil {
			offTasks()
		}
		s.Close()
	}
}

// fleetExternal：编程助手监视的状态 → 外部会话（只要本机会话文件来的；Nomi 标签的会话由标签代表）
func fleetExternal(st *util.Obj) []fleet.ExtSession {
	out := []fleet.ExtSession{}
	arr, _ := st.Get("sessions").([]any)
	for _, x := range arr {
		v, ok := x.(*util.Obj)
		if !ok || v.Get("source") != "file" {
			continue
		}
		str := func(k string) string { s, _ := v.Get(k).(string); return s }
		at, _ := v.Get("updatedAt").(float64)
		if at == 0 {
			at, _ = v.Get("mtime").(float64)
		}
		e := fleet.ExtSession{ID: str("id"), Kind: str("kind"), Title: str("title"), Cwd: str("cwd"), Status: str("status"),
			Summary: str("summary"), UpdatedAt: int64(at)}
		if b, ok := v.Get("alive").(bool); ok {
			e.Alive = &b
		}
		out = append(out, e)
	}
	return out
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
