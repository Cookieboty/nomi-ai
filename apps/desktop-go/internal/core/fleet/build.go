// Package fleet：Agent 看板（docs/development/agent-board.md）。把 Nomi 本体、Nomi 的后台运行、
// 编排器里的 CLI 标签（对话委派 / 任务派出 / 工坊里直接用的）和用户在 Nomi 之外开的 CLI 拼成一份看板数据。
//
// 纳管（managed，可暂停）= 在 Nomi 里跑的；外部（external）= Nomi 进程树之外的编程助手进程，只能预警，
// 这里只读它的资源占用，任何控制都不经过这里。
package fleet

import (
	"sort"
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/agents"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
)

// 看板分列（契约 FleetColumn）
const (
	ColTodo    = "todo"
	ColPaused  = "paused"
	ColRunning = "running"
	ColDone    = "done"
)

// 需要用户处理（契约 FleetNeedsYou）
const (
	NeedPermission = "permission"
	NeedSandbox    = "sandbox"
	NeedAccept     = "accept"
)

// AutoArchiveMs：已完成的多久没动静就不再显示（看板不保留历史）
const AutoArchiveMs = 2 * 60 * 60_000

// SelfID：Nomi 本体的 id
const SelfID = "nomi"

type Usage struct {
	RSSBytes   float64 `json:"rssBytes"`
	CPUPercent float64 `json:"cpuPercent"`
	Processes  int     `json:"processes"`
}

// Agent = 契约 FleetAgent
type Agent struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Backend        string `json:"backend"`
	Scope          string `json:"scope"`
	Origin         string `json:"origin"`
	Title          string `json:"title"`
	Column         string `json:"column"`
	NeedsYou       string `json:"needsYou,omitempty"`
	Failed         bool   `json:"failed,omitempty"`
	ParentID       string `json:"parentId,omitempty"`
	TaskID         string `json:"taskId,omitempty"`
	TabID          string `json:"tabId,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	Usage          *Usage `json:"usage,omitempty"`
	UpdatedAt      int64  `json:"updatedAt"`
}

type System struct {
	TotalMemBytes float64 `json:"totalMemBytes"`
	Cores         int     `json:"cores"`
	CPUPercent    float64 `json:"cpuPercent"`
}

// State = 契约 FleetState
type State struct {
	Agents    []Agent `json:"agents"`
	System    System  `json:"system"`
	SampledAt int64   `json:"sampledAt"`
}

// Tab：编排器里一个标签的看板相关信息（wiring 从 ListTabs 与编排器查询里取）
type Tab struct {
	ID, Title, Backend, Cwd, Status string
	HasSession                      bool // 有 CLI 会话 = 跑过；从没跑过的空标签不上看板
	UpdatedAt                       int64
	// Delegated：Nomi 派出且没被用户接手；CallID 非空 = 对话里委派的，否则 TaskID 非空 = 任务派的
	Delegated      bool
	CallID, TaskID string
	Pids           []int
	PendingPerms   int
	SandboxPending int
}

// Input：拼一份看板数据要的全部输入
type Input struct {
	Now      int64
	SelfPid  float64
	Tabs     []Tab
	Tasks    []tasks.Task
	Procs    *agents.ProcTable // nil = 读不到进程表（只是没有资源占用）
	PrevProc *agents.ProcTable // 上一次采样（算 CPU）；nil = 第一次
	// Archived：id → 归档时间；之后没有新动静（UpdatedAt ≤ 归档时间）的已完成项不显示
	Archived map[string]int64
	System   System
}

func tabOrigin(t Tab) string {
	switch {
	case t.Delegated && t.CallID != "":
		return "conversation"
	case t.Delegated && t.TaskID != "":
		return "task"
	}
	return "workbench"
}

// taskColumn：任务状态 → 分列与需要处理；ok = false 表示不上看板（idle：没在干活）
func taskColumn(status string) (col, need string, failed, ok bool) {
	switch status {
	case tasks.StatusQueued:
		return ColTodo, "", false, true
	case tasks.StatusRunning:
		return ColRunning, "", false, true
	case tasks.StatusWaitingUser, tasks.StatusNeedsReconcile:
		return ColRunning, NeedPermission, false, true
	case tasks.StatusAwaitingAccept:
		return ColDone, NeedAccept, false, true
	case tasks.StatusDone, tasks.StatusCancelled:
		return ColDone, "", false, true
	case tasks.StatusFailed, tasks.StatusExpired:
		return ColDone, "", true, true
	}
	return "", "", false, false
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// treeUsage：一组根进程的整棵树（去重）的占用；seen 记下用过的进程，避免与 Nomi 本体重复计算
func treeUsage(in Input, roots []float64, seen map[float64]bool) *Usage {
	if in.Procs == nil || len(roots) == 0 {
		return nil
	}
	pids := []float64{}
	for _, r := range roots {
		for _, p := range in.Procs.Subtree(r) {
			if !seen[p] {
				seen[p] = true
				pids = append(pids, p)
			}
		}
	}
	if len(pids) == 0 {
		return nil
	}
	u := &Usage{Processes: len(pids), CPUPercent: in.Procs.CPUSince(in.PrevProc, pids)}
	for _, p := range pids {
		if rp, ok := in.Procs.Get(p); ok {
			u.RSSBytes += rp.RSS
		}
	}
	return u
}

// Build：拼看板数据。顺序：Nomi 本体、纳管（标签与后台运行，按更新时间新的在前）、外部（按内存大的在前）。
func Build(in Input) State {
	byTask := map[string]tasks.Task{}
	for _, t := range in.Tasks {
		byTask[t.ID] = t
	}
	seen := map[float64]bool{}
	managed := []Agent{}
	tabTask := map[string]bool{}

	for _, t := range in.Tabs {
		col, need, failed := "", "", false
		switch t.Status {
		case "running":
			col = ColRunning
		case "queued":
			col = ColTodo
		case "error":
			col, failed = ColDone, true
		default:
			if !t.HasSession {
				continue
			}
			col = ColDone
		}
		a := Agent{ID: "tab:" + t.ID, Kind: "cli", Backend: t.Backend, Scope: "managed", Origin: tabOrigin(t),
			Title: t.Title, TabID: t.ID, Cwd: t.Cwd, UpdatedAt: t.UpdatedAt}
		if t.Delegated && t.TaskID != "" {
			a.TaskID = t.TaskID
			tabTask[t.TaskID] = true
			if task, ok := byTask[t.TaskID]; ok {
				a.ConversationID = str(task.Origin.ConversationID)
				switch task.Status {
				case tasks.StatusAwaitingAccept:
					col, need = ColDone, NeedAccept
				case tasks.StatusWaitingUser:
					need = NeedPermission
				}
			}
		}
		switch {
		case t.PendingPerms > 0:
			need = NeedPermission
		case t.SandboxPending > 0:
			need = NeedSandbox
		}
		if need == NeedPermission || need == NeedSandbox {
			col = ColRunning
		}
		a.Column, a.NeedsYou, a.Failed = col, need, failed
		roots := make([]float64, len(t.Pids))
		for i, p := range t.Pids {
			roots[i] = float64(p)
		}
		a.Usage = treeUsage(in, roots, seen)
		managed = append(managed, a)
	}

	for _, t := range in.Tasks {
		col, need, failed, ok := taskColumn(t.Status)
		if !ok {
			continue
		}
		var a Agent
		switch t.Executor.Kind {
		case "nomi":
			a = Agent{ID: "run:" + t.ID, Kind: "nomi", Backend: "nomi", Origin: "nomi"}
		case "cli":
			// 已经有标签的由标签代表；还没开标签的只在排队时出现
			if tabTask[t.ID] || col != ColTodo {
				continue
			}
			a = Agent{ID: "run:" + t.ID, Kind: "cli", Backend: str(t.Executor.Cli), Origin: "task", Cwd: str(t.Executor.Cwd)}
		default:
			continue
		}
		a.Scope, a.Title, a.Column, a.NeedsYou, a.Failed = "managed", t.Title, col, need, failed
		a.TaskID, a.ConversationID, a.UpdatedAt = t.ID, str(t.Origin.ConversationID), t.UpdatedAt
		managed = append(managed, a)
	}

	// 已完成的：归档过且之后没动静的、太久没动静的不显示
	shown := managed[:0]
	for _, a := range managed {
		if a.Column == ColDone && a.NeedsYou == "" {
			if at, ok := in.Archived[a.ID]; ok && a.UpdatedAt <= at {
				continue
			}
			if in.Now-a.UpdatedAt > AutoArchiveMs {
				continue
			}
		}
		shown = append(shown, a)
	}
	managed = shown
	sort.SliceStable(managed, func(i, j int) bool { return managed[i].UpdatedAt > managed[j].UpdatedAt })

	// Nomi 本体：自己的进程树减去标签的进程树（内核、Nomi 跑的命令、本地模型等）
	self := Agent{ID: SelfID, Kind: "nomi", Backend: "nomi", Scope: "managed", Origin: "self", Column: ColRunning, UpdatedAt: in.Now}
	self.Usage = treeUsage(in, []float64{in.SelfPid}, seen)

	external := []Agent{}
	if in.Procs != nil {
		for _, tr := range agents.AgentTrees(in.Procs, in.SelfPid) {
			if tr.InNomi {
				continue
			}
			pid := strconv.FormatInt(int64(tr.Root.Pid), 10)
			external = append(external, Agent{ID: "ext:" + pid, Kind: "cli", Backend: tr.Root.Kind, Scope: "external",
				Origin: "terminal", Column: ColRunning, UpdatedAt: in.Now,
				Usage: &Usage{RSSBytes: tr.RSS, CPUPercent: in.Procs.CPUSince(in.PrevProc, tr.Pids), Processes: len(tr.Pids)}})
		}
		sort.SliceStable(external, func(i, j int) bool { return external[i].Usage.RSSBytes > external[j].Usage.RSSBytes })
	}

	out := append([]Agent{self}, managed...)
	return State{Agents: append(out, external...), System: in.System, SampledAt: in.Now}
}
