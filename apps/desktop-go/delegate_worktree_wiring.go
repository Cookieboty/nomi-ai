package main

// 委派与持续任务共用的编程助手工作目录协调：
//   - delegateClaims：同一仓库里直接改的并行任务按文件、按优先级裁决（delegate/claims.go）；
//     编排器的工具事件（改文件类）喂给它，输的一方经 SteerTab 收到插话。
//   - sweepDelegateWorktrees：启动时清理没人认领的委派 worktree（有改动的先提交到新分支）。
//   - closeStaleDelegatedTabs：委派标签只在 Nomi 里看，用户没法在侧栏关掉：启动时关掉闲置很久、任务已结束的。

import (
	"log"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

var delegateClaims = delegate.NewClaims()

// wireDelegateClaims：编排器就绪后接上插话与工具事件
func wireDelegateClaims(o *harness.Orchestrator) {
	delegateClaims.SetSteer(func(tabID, text string) bool {
		p, err := gilErr(func() *jsrt.Promise[bool] { return o.SteerTab(tabID, text) })
		if err != nil {
			return false
		}
		ok, _ := jsrt.Block(p)
		return ok
	})
	jsrt.Run(func() {
		o.Events().OnOff("event", func(v any) {
			x, _ := v.(*util.Obj)
			if x == nil {
				return
			}
			ev, _ := x.Get("event").(*util.Obj)
			if ev == nil || ev.Get("type") != "tool" || ev.Get("status") == "error" {
				return
			}
			tabID := util.Str(x.Get("tabId"))
			paths := delegate.EditedPaths(util.Str(ev.Get("name")), util.Str(ev.Get("input")))
			if len(paths) == 0 {
				return
			}
			// 编排器的回调持锁：转到别的 goroutine（Touch 可能插话，插话要进编排器）
			go func() {
				if delegateClaims.Active(tabID) {
					delegateClaims.Touch(tabID, paths)
				}
			}()
		})
	})
}

// sweepDelegateWorktrees：启动时扫一遍用过的仓库，拆掉没人认领的委派 worktree。
// 认领：没结束的持续任务的执行载体、还开着的标签（含用户接手的）的工作目录
func sweepDelegateWorktrees(o *harness.Orchestrator, ts *tasks.Service) {
	roots := []string{}
	keep := map[string]bool{}
	if o != nil {
		roots = append(roots, jsrt.Call(o.RecentCwds)...)
		tabs, _ := jsrt.Call(o.ListTabs).Get("tabs").([]any)
		for _, t := range tabs {
			if x, ok := t.(*util.Obj); ok {
				if cwd := util.Str(x.Get("cwd")); cwd != "" {
					keep[cwd] = true
					if delegate.IsDelegateWorktree(cwd) {
						continue
					}
					roots = append(roots, cwd)
				}
			}
		}
	}
	if ts != nil {
		for _, t := range ts.Runtime.List() {
			rec := ts.Runtime.Get(t.ID)
			if rec == nil {
				continue
			}
			for _, a := range rec.Attempts {
				c := a.Carrier
				if c == nil {
					continue
				}
				if c.GitRoot != nil && *c.GitRoot != "" {
					roots = append(roots, *c.GitRoot)
				}
				if c.Worktree != nil && *c.Worktree != "" && !retiredTaskStatus(rec.Task.Status) {
					keep[*c.Worktree] = true
				}
			}
		}
	}
	removed := delegate.SweepOrphanWorktrees(roots, func(p string) bool { return keep[p] },
		func(m string) { log.Printf("[delegate] %s", m) })
	if len(removed) > 0 {
		log.Printf("[delegate] removed %d orphan worktree(s): %s", len(removed), strings.Join(removed, ", "))
	}
}

func retiredTaskStatus(s string) bool {
	switch s {
	case tasks.StatusDone, tasks.StatusIdle, tasks.StatusCancelled, tasks.StatusExpired, tasks.StatusFailed:
		return true
	}
	return false
}

// staleDelegatedTabMs：委派标签闲置多久后关掉（同一种委派复用会话只看一小时内的，留一周给对话里的卡片查看）
const staleDelegatedTabMs = 7 * 24 * 60 * 60_000

// closeStaleDelegatedTabs：关掉闲置超过一周、没被用户接手、对应任务已结束的委派标签
func closeStaleDelegatedTabs(o *harness.Orchestrator) {
	if o == nil {
		return
	}
	now := float64(time.Now().UnixMilli())
	tabs, _ := jsrt.Call(o.ListTabs).Get("tabs").([]any)
	for _, t := range tabs {
		x, _ := t.(*util.Obj)
		if x == nil || x.Get("status") != "idle" {
			continue
		}
		d, _ := x.Get("delegation").(*util.Obj)
		if d == nil || d.Get("by") != "nomi" || util.Truthy(d.Get("takenOver")) {
			continue
		}
		if at, _ := x.Get("updatedAt").(float64); now-at < staleDelegatedTabMs {
			continue
		}
		if id := util.Str(d.Get("taskId")); id != "" && taskBusy(id) {
			continue
		}
		id := util.Str(x.Get("id"))
		if _, err := gilErr(func() *util.Obj { return o.CloseTab(id) }); err != nil {
			log.Printf("[delegate] close stale tab %s: %v", id, err)
		}
	}
}
