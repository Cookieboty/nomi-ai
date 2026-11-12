// Package fleet：Agent 看板（docs/development/agent-board.md）。把正在回答的 Nomi 对话、Nomi 的后台运行、
// 编排器里的 CLI 标签（对话委派 / 任务派出 / 工坊里直接用的）和用户在 Nomi 之外开的编程助手会话
// 拼成一份看板数据；Nomi 本体不进分列，单独给出它的资源占用。
//
// 纳管（managed，可暂停）= 在 Nomi 里跑的；外部（external）= Nomi 进程树之外的编程助手会话，只能预警，
// 这里只读它的状态与资源占用，任何控制都不经过这里。
package fleet

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"

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
	// NeedQuestion：有结构化问题在等用户回答（Nomi 的 ask_user / Claude AskUserQuestion）
	NeedQuestion = "question"
)

// AutoArchiveMs：已完成的多久没动静就不再显示（看板不保留历史）
const AutoArchiveMs = 2 * 60 * 60_000

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
	// Paused：暂停中（已暂停列）；Pausable：可以手动暂停（CLI 标签：纳管、在跑、有活着的进程、没在等审批或提问；
	// 后台 Nomi：在跑或排队、没在等用户。后台 Nomi 的暂停是任务暂停：这一轮跑完，之后不再调度，等手动继续）
	Paused   *Paused `json:"paused,omitempty"`
	Pausable bool    `json:"pausable,omitempty"`
	// Summary：做完时的总结（标签最后一条回复、任务的结果摘要、外部会话的摘要），只给已完成的，截到 SummaryMax 个字
	Summary string `json:"summary,omitempty"`
	// QueueReason：在「待进行」里为什么还没开始：memory 内存紧张被内存守护扣着 / slot 等前面的任务（并发名额满或
	// 每小时启动次数到了）/ retry 上次失败、等重试（RetryAt）
	QueueReason string `json:"queueReason,omitempty"`
	RetryAt     int64  `json:"retryAt,omitempty"`
}

// 排队原因（Agent.QueueReason）
const (
	QueueMemory = "memory"
	// QueueCPU：「全速」档里整机 CPU 太忙，先排着（policy.go）
	QueueCPU   = "cpu"
	QueueSlot  = "slot"
	QueueRetry = "retry"
)

// SummaryMax：卡片上的总结最多多少个字（视图再按行数截）
const SummaryMax = 300

// clip：压掉多余空白、去掉 Markdown 的标题 / 加粗 / 代码围栏符号，截到 SummaryMax 个字
func clip(s string) string {
	s = mdNoise.ReplaceAllString(s, "")
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > SummaryMax {
		return string(r[:SummaryMax]) + "…"
	}
	return s
}

var mdNoise = regexp.MustCompile("(?m)^#{1,6}\\s+|\\*\\*|__|```[a-zA-Z0-9_-]*|`")

// 谁暂停的
const (
	PausedByMemory = "memory"
	PausedByUser   = "user"
	// PausedByNomi：Nomi 用 pause_agent 暂停的（和内存守护暂停的一样，内存恢复正常后自动继续）
	PausedByNomi = "nomi"
)

// Paused：暂停信息（冻结的进程不占 CPU，内存由系统按需压缩换出；恢复后这一轮从原处接着跑）
type Paused struct {
	By string `json:"by"`
	At int64  `json:"at"`
}

type System struct {
	TotalMemBytes float64 `json:"totalMemBytes"`
	Cores         int     `json:"cores"`
	CPUPercent    float64 `json:"cpuPercent"`
	// Pressure：系统内存压力 normal / warn / critical / unknown；AvailablePercent 可用内存比例（不知道时没有）
	Pressure         string   `json:"pressure"`
	AvailablePercent *float64 `json:"availablePercent,omitempty"`
}

// Action：内存守护最近做的一件事（看板上一行提示）
type Action struct {
	// Kind：reclaimed 回收空闲进程 / paused 暂停 / resumed 恢复
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	Count int    `json:"count,omitempty"`
	At    int64  `json:"at"`
}

// Governor：内存守护的开关与最近一次动作
type Governor struct {
	AutoPause bool    `json:"autoPause"`
	Last      *Action `json:"last,omitempty"`
}

// Nomi：Nomi 本体（调度者）的资源占用：自己的进程树减去各标签的树
type Nomi struct {
	Usage *Usage `json:"usage,omitempty"`
}

// IdleItem：一棵没在跑会话的外部编程助手进程树（用户可以手动关掉，见 Service.CloseIdle）
type IdleItem struct {
	Pid        float64 `json:"pid"`
	Backend    string  `json:"backend"`
	Cwd        string  `json:"cwd,omitempty"`
	Processes  int     `json:"processes"`
	RSSBytes   float64 `json:"rssBytes"`
	CPUPercent float64 `json:"cpuPercent"`
}

// Idle：Nomi 之外、对不上正在跑的会话的编程助手进程（空闲的终端 / IDE 里的助手），按内存大的在前
type Idle struct {
	Processes int        `json:"processes"`
	RSSBytes  float64    `json:"rssBytes"`
	Items     []IdleItem `json:"items"`
}

// State = 契约 FleetState
type State struct {
	Agents       []Agent  `json:"agents"`
	Nomi         Nomi     `json:"nomi"`
	ExternalIdle Idle     `json:"externalIdle"`
	System       System   `json:"system"`
	Governor     Governor `json:"governor"`
	Policy       Policy   `json:"policy"`
	// PolicyOptions：可选的三档（视图照着列，不自己写数值）
	PolicyOptions []Policy `json:"policyOptions"`
	SampledAt     int64    `json:"sampledAt"`
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
	// PendingQuestions：有结构化问题在等用户（优先于普通权限，看板标「等你处理」）
	PendingQuestions int
	SandboxPending   int
	Paused           *Paused // 冻结中
	Summary          string  // 最后一条回复（只在没在跑时取）
	// ParentTaskID：后台 Nomi 运行里派出的：那次运行的任务 id（调度树）
	ParentTaskID string
}

// Chat：正在回答的 Nomi 对话（标题由视图从会话列表里取）
type Chat struct {
	ConversationID string
	StartedAt      int64
	// WaitingUser：这一轮停在 ask_user，等用户回答
	WaitingUser bool
}

// ExtSession：编程助手监视（agents）认出的、Nomi 之外的会话（不含 Nomi 标签自己的会话）
type ExtSession struct {
	ID, Kind, Title, Cwd, Status string
	Summary                      string
	UpdatedAt                    int64
	Alive                        *bool // nil = 不知道
}

// Input：拼一份看板数据要的全部输入
type Input struct {
	Now     int64
	SelfPid float64
	// OwnProcsOnly：不列 Nomi 进程树之外的编程助手进程（Mock CLI 演示 / 截图环境用，不把本机真实会话的目录带进画面）
	OwnProcsOnly bool
	Tabs         []Tab
	Tasks        []tasks.Task
	Chats        []Chat
	External     []ExtSession
	// ExtCwd：编程助手进程的工作目录（pid → 目录），把外部进程树对到会话上
	ExtCwd map[float64]string
	// ExtSession：登记了当前会话的编程助手进程（pid → 外部会话 id，如 Claude Code 的 ~/.claude/sessions/<pid>.json）。
	// 这些进程树只归对应的会话，不按目录分给别的会话；会话还没出现（刚开、没发消息）就算空闲
	ExtSession map[float64]string
	Procs      *agents.ProcTable // nil = 读不到进程表（只是没有资源占用）
	PrevProc   *agents.ProcTable // 上一次采样（算 CPU）；nil = 第一次
	// Archived：id → 归档时间；之后没有新动静（UpdatedAt ≤ 归档时间）的已完成项不显示
	Archived map[string]int64
	// TaskSummaries：任务 id → 最近一次运行的结果摘要（只有做完的）
	TaskSummaries map[string]string
	// ConversationOwned：已经交回来源对话处理的「等你验收」任务（对话里委派的、结果已回到对话）：放在已完成，不标要你处理
	ConversationOwned map[string]bool
	// TaskControl：能暂停 / 继续后台 Nomi（有任务命令入口）；TaskPausedBy：任务 id → 谁在看板上暂停的（没有 = 用户）
	TaskControl  bool
	TaskPausedBy map[string]string
	// Holding：正扣着新的编程助手与后台 Nomi（排队的任务卡片标 QueueReason = memory / cpu）
	Holding bool
	// HoldReason：扣着的原因（memory 内存 / cpu 整机 CPU，「全速」档才看 CPU）；空 = memory
	HoldReason string
	System     System
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
// taskPaused：执行者为 nomi 的持续任务被暂停了（停了调度、还没结束）。连续失败后自动停掉的不算，那是失败不是暂停
func taskPaused(t tasks.Task) bool {
	return t.Executor.Kind == "nomi" && !t.Enabled && !tasks.IsTerminal(t.Status) &&
		t.ConsecutiveFailures < tasks.AutoPauseAfterFailures
}

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

// extColumn：外部会话状态（agents 的 AgentStatus）→ 分列；ok = false 表示不上看板（idle）。
// 等用户回话（waiting）= 这一轮已经答完，算已完成。
func extColumn(s ExtSession) (col, need string, failed, ok bool) {
	switch s.Status {
	case "running", "stalled":
		col = ColRunning
	case "waiting", "completed":
		col = ColDone
	case "failed":
		col, failed = ColDone, true
	default:
		return "", "", false, false
	}
	// 进程已经没了：不再算在跑
	if col == ColRunning && s.Alive != nil && !*s.Alive {
		col = ColDone
	}
	return col, need, failed, true
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func normDir(p string) string {
	if p == "" {
		return ""
	}
	return strings.TrimRight(filepath.Clean(p), `/\`)
}

// usageOf：一组进程（已去重）的占用
func usageOf(in Input, pids []float64) *Usage {
	if in.Procs == nil || len(pids) == 0 {
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
	return usageOf(in, pids)
}

func (in Input) hidden(a Agent) bool {
	if a.Column != ColDone || a.NeedsYou != "" {
		return false
	}
	if at, ok := in.Archived[a.ID]; ok && a.UpdatedAt <= at {
		return true
	}
	return in.Now-a.UpdatedAt > AutoArchiveMs
}

// Build：拼看板数据。纳管的按更新时间新的在前，外部的跟在后面（同样新的在前）。
func Build(in Input) State {
	byTask := map[string]tasks.Task{}
	for _, t := range in.Tasks {
		byTask[t.ID] = t
	}
	seen := map[float64]bool{}
	managed := []Agent{}
	tabTask := map[string]bool{}

	for _, c := range in.Chats {
		a := Agent{ID: "chat:" + c.ConversationID, Kind: "nomi", Backend: "nomi", Scope: "managed",
			Origin: "chat", Column: ColRunning, ConversationID: c.ConversationID, UpdatedAt: c.StartedAt}
		if c.WaitingUser {
			a.NeedsYou = NeedQuestion
		}
		managed = append(managed, a)
	}

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
		if t.ParentTaskID != "" {
			a.ParentID = "run:" + t.ParentTaskID
		}
		if t.Delegated && t.TaskID != "" {
			a.TaskID = t.TaskID
			tabTask[t.TaskID] = true
			if task, ok := byTask[t.TaskID]; ok {
				a.ConversationID = str(task.Origin.ConversationID)
				switch task.Status {
				case tasks.StatusAwaitingAccept:
					col, need = ColDone, NeedAccept
					if in.ConversationOwned[t.TaskID] {
						need = ""
					}
				case tasks.StatusWaitingUser:
					need = NeedPermission
				}
			}
		}
		switch {
		case t.PendingQuestions > 0:
			need = NeedQuestion
		case t.PendingPerms > 0:
			need = NeedPermission
		case t.SandboxPending > 0:
			need = NeedSandbox
		}
		if need == NeedPermission || need == NeedSandbox || need == NeedQuestion {
			col = ColRunning
		}
		if t.Paused != nil {
			col, a.Paused = ColPaused, t.Paused
		}
		a.Column, a.NeedsYou, a.Failed = col, need, failed
		a.Pausable = t.Paused == nil && col == ColRunning && need == "" && len(t.Pids) > 0
		// 编排器里排队的标签：同时运行的标签数满了
		if col == ColTodo {
			a.QueueReason = QueueSlot
		}
		if col == ColDone {
			a.Summary = clip(t.Summary)
			if a.Summary == "" && a.TaskID != "" {
				a.Summary = clip(in.TaskSummaries[a.TaskID])
			}
		}
		roots := make([]float64, len(t.Pids))
		for i, p := range t.Pids {
			roots[i] = float64(p)
		}
		a.Usage = treeUsage(in, roots, seen)
		managed = append(managed, a)
	}

	for _, t := range in.Tasks {
		col, need, failed, ok := taskColumn(t.Status)
		// 暂停了的后台 Nomi（任务停了调度）：空闲 / 排队的进「已暂停」；这一轮还在跑、等用户的留在原列，标着暂停
		paused := taskPaused(t)
		if paused && (!ok || col == ColTodo) {
			col, need, failed, ok = ColPaused, "", false, true
		}
		if !ok {
			continue
		}
		if need == NeedAccept && in.ConversationOwned[t.ID] {
			need = ""
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
		if paused {
			by := in.TaskPausedBy[t.ID]
			if by == "" {
				by = PausedByUser
			}
			a.Paused = &Paused{By: by, At: t.UpdatedAt}
		} else if a.Kind == "nomi" && in.TaskControl && t.Enabled && need == "" && (col == ColRunning || col == ColTodo) {
			a.Pausable = true
		}
		if col == ColTodo {
			switch {
			case t.Pending != nil && t.Pending.NotBefore != nil && *t.Pending.NotBefore > in.Now:
				a.QueueReason, a.RetryAt = QueueRetry, *t.Pending.NotBefore
			case in.Holding && in.HoldReason == QueueCPU:
				a.QueueReason = QueueCPU
			case in.Holding:
				a.QueueReason = QueueMemory
			default:
				a.QueueReason = QueueSlot
			}
		}
		if col == ColDone {
			a.Summary = clip(in.TaskSummaries[t.ID])
		}
		managed = append(managed, a)
	}

	shown := managed[:0]
	for _, a := range managed {
		if !in.hidden(a) {
			shown = append(shown, a)
		}
	}
	managed = shown
	sort.SliceStable(managed, func(i, j int) bool { return managed[i].UpdatedAt > managed[j].UpdatedAt })

	// Nomi 本体：自己的进程树减去标签的进程树（内核、Nomi 跑的命令、本地模型等）
	nomi := Nomi{Usage: treeUsage(in, []float64{in.SelfPid}, seen)}

	external, idle := buildExternal(in)
	return State{Agents: append(managed, external...), Nomi: nomi, ExternalIdle: idle, System: in.System, SampledAt: in.Now}
}

// treeSession：进程树里登记的会话（先看根进程，再看子孙）
func treeSession(m map[float64]string, tr agents.AgentTree) string {
	if id := m[tr.Root.Pid]; id != "" {
		return id
	}
	for _, p := range tr.Pids {
		if id := m[p]; id != "" {
			return id
		}
	}
	return ""
}

// buildExternal：外部会话按状态分列；在跑的会话认领同种助手、同一目录的进程树（一棵树只归一个会话），
// 认领不到的进程树合并成「空闲进程」。
func buildExternal(in Input) ([]Agent, Idle) {
	type tree struct {
		t       agents.AgentTree
		key     string
		sess    string // 登记的会话 id（"" = 不知道）
		claimed bool
	}
	trees := []*tree{}
	if in.Procs != nil {
		for _, tr := range agents.AgentTrees(in.Procs, in.SelfPid) {
			if tr.InNomi || in.OwnProcsOnly {
				continue
			}
			trees = append(trees, &tree{t: tr, key: tr.Root.Kind + "\x1f" + normDir(in.ExtCwd[tr.Root.Pid]), sess: treeSession(in.ExtSession, tr)})
		}
	}

	sessions := append([]ExtSession(nil), in.External...)
	sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
	out := []Agent{}
	for _, s := range sessions {
		col, need, failed, ok := extColumn(s)
		if !ok {
			continue
		}
		a := Agent{ID: "ext:" + s.ID, Kind: "cli", Backend: s.Kind, Scope: "external", Origin: "terminal",
			Title: s.Title, Column: col, NeedsYou: need, Failed: failed, Cwd: s.Cwd, UpdatedAt: s.UpdatedAt}
		if col == ColDone {
			a.Summary = clip(s.Summary)
		}
		out = append(out, a)
	}
	// 会话认领它的进程树：同种助手、同一目录。先让在跑的认领，再让答完了但进程还开着的认领（会话还在，进程不算空闲）
	// 登记了会话的进程树先精确归到自己的会话
	for i := range out {
		id := strings.TrimPrefix(out[i].ID, "ext:")
		for _, tr := range trees {
			if !tr.claimed && tr.sess != "" && tr.sess == id {
				tr.claimed = true
				out[i].Usage = usageOf(in, tr.t.Pids)
				break
			}
		}
	}
	claim := func(a *Agent) {
		if a.Cwd == "" || a.Usage != nil {
			return
		}
		key := a.Backend + "\x1f" + normDir(a.Cwd)
		for _, tr := range trees {
			if !tr.claimed && tr.sess == "" && tr.key == key {
				tr.claimed = true
				a.Usage = usageOf(in, tr.t.Pids)
				return
			}
		}
	}
	alive := map[string]bool{}
	for _, s := range sessions {
		alive["ext:"+s.ID] = s.Alive == nil || *s.Alive
	}
	for i := range out {
		if out[i].Column == ColRunning {
			claim(&out[i])
		}
	}
	for i := range out {
		if out[i].Column == ColDone && alive[out[i].ID] {
			claim(&out[i])
		}
	}
	shown := out[:0]
	for _, a := range out {
		if !in.hidden(a) {
			shown = append(shown, a)
		}
	}
	out = shown

	idle := Idle{Items: []IdleItem{}}
	for _, tr := range trees {
		if tr.claimed {
			continue
		}
		idle.Processes += len(tr.t.Pids)
		idle.RSSBytes += tr.t.RSS
		idle.Items = append(idle.Items, IdleItem{Pid: tr.t.Root.Pid, Backend: tr.t.Root.Kind, Cwd: in.ExtCwd[tr.t.Root.Pid],
			Processes: len(tr.t.Pids), RSSBytes: tr.t.RSS, CPUPercent: in.Procs.CPUSince(in.PrevProc, tr.t.Pids)})
	}
	sort.SliceStable(idle.Items, func(i, j int) bool { return idle.Items[i].RSSBytes > idle.Items[j].RSSBytes })
	return out, idle
}
