package tasks

// `cli` 执行者：用户装好、配好的编程助手在后台标签里执行任务（docs/design/persistent-tasks.md §7.2、§7.3）。
// 对应 src/tasks/executors/cli.ts：worktree 隔离、授权等级换算权限档、审批先过确定性命令分类、
// 用户在标签里接手 → takenOver、完成后按 git 列改动但不自动回填（回填是验收卡片上的单独动作）。

import (
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

// CliTabEvent：编排器的标签事件（只用到审批相关字段）
type CliTabEvent struct {
	TabID   string
	Type    string
	ID      string
	Summary string
	Kind    string
}

// CliCreateTab：新建后台标签的参数
type CliCreateTab struct {
	Backend        string
	Cwd            string
	Title          string
	PermissionMode string // plan | acceptEdits
	Goal           string
	TaskID         string
	ModelOverride  string
	// GithubAccess：授权里有 GitHub 对外能力，标签不隔离 gh 登录
	GithubAccess bool
}

// CliSendResult：一轮的结果
type CliSendResult struct {
	Text         string
	InputTokens  int64
	OutputTokens int64
	CostUsd      *float64
}

// CliHarness：编排器的子集；SendTab 阻塞到这一轮结束
type CliHarness interface {
	Bins() map[string]bool
	CreateTab(o CliCreateTab) (string, error)
	HasTab(id string) bool
	SendTab(id, prompt string) (CliSendResult, error)
	CancelTab(id string)
	ReplyPermission(tabID, requestID string, allow bool) bool
	TakenOver(id string) bool
	OnEvent(fn func(CliTabEvent)) func()
	// IsStopped：标签被停 / 接管（harness.StoppedError）
	IsStopped(err error) bool
}

// CliIsolation：prepareIsolation 的结果
type CliIsolation struct {
	Kind         string // worktree | shared-cwd
	Cwd          string
	SourceCwd    string
	GitRoot      string
	WorktreePath string
}

// CliReport：[nomi-report] 解析结果
type CliReport struct {
	Done         string
	ChangedFiles []string
	Unfinished   string
	NeedsUser    string
}

type CliDeps struct {
	Harness          CliHarness
	PrepareIsolation func(sourceCwd, key string) (CliIsolation, error)
	GitChanged       func(cwd string) []string // nil = 不在 git 仓库里
	BuildPrompt      func(goal, context, doneWhen string) string
	ParseReport      func(text string) *CliReport
	// DirOk：目录还存在、仍是用户认可的工作区
	DirOk func(dir string) bool
	// EventsFor：这次执行要处理的事件（事件触发时）
	EventsFor func(taskID string, eventKey *string) []SourceEvent
}

type cliRun struct {
	gen     int
	tabID   string
	ctx     AttemptContext
	pending map[string]bool
	stopped bool
}

type cliExecutor struct {
	d    CliDeps
	mu   sync.Mutex
	runs map[string]*cliRun
}

func NewCliExecutor(d CliDeps) Executor { return &cliExecutor{d: d, runs: map[string]*cliRun{}} }

var classRank = map[string]int{"external": 1, "never": 2, "credential": 3}

// ClassifySummary：整行与「标题: 」后面的部分都分类，取更严重的
func ClassifySummary(summary string) string {
	a := desktop.ClassifyCommand(summary)
	b := ""
	if i := strings.Index(summary, ":"); i >= 0 {
		b = desktop.ClassifyCommand(summary[i+1:])
	}
	if a == "" {
		return b
	}
	if b == "" || classRank[a] >= classRank[b] {
		return a
	}
	return b
}

// GithubAccess：授权里有 GitHub 连接的对外能力（github.read 以外）：标签不隔离 gh 登录（connections.md §4.4）
func GithubAccess(t Task) bool {
	for _, c := range t.Grant.Connections {
		for _, x := range c.Capabilities {
			if strings.HasPrefix(x, "github.") && x != "github.read" {
				return true
			}
		}
	}
	return false
}

// DecidePermission：allow 直接放行；ask 停下来等人；deny 授权外，直接拒绝（§8.4）
func DecidePermission(level int, kind, summary string, tainted bool) string {
	if kind == "approve-plan" {
		return "ask"
	}
	switch ClassifySummary(summary) {
	case "credential", "never":
		return "ask"
	case "external":
		if level >= 4 {
			return "allow"
		}
		return "ask"
	}
	if level < 3 {
		return "deny"
	}
	if tainted {
		return "ask"
	}
	return "allow"
}

func (e *cliExecutor) Prepare(t Task) (ExecutionSnapshot, *TaskError) {
	ex := t.Executor
	if ex.Kind != "cli" || ex.Cli == nil || ex.Cwd == nil {
		return ExecutionSnapshot{}, &TaskError{Code: "executor_failed", Message: "not a cli task"}
	}
	// 用户点名的编程助手不可用：失败并提示，不悄悄换成别的（§7.3）
	if !e.d.Harness.Bins()[*ex.Cli] {
		return ExecutionSnapshot{}, &TaskError{Code: "config_changed", Message: *ex.Cli + " is not installed"}
	}
	if !e.d.DirOk(*ex.Cwd) {
		return ExecutionSnapshot{}, &TaskError{Code: "config_changed", Message: "workspace unavailable: " + *ex.Cwd}
	}
	snap := ExecutionSnapshot{GrantVersion: t.Grant.Version, Cli: ptr(*ex.Cli), Cwd: ptr(*ex.Cwd)}
	if ex.Model != nil && *ex.Model != "" {
		snap.Model = ptr(*ex.Model)
	}
	return snap, nil
}

func (e *cliExecutor) promptFor(ctx AttemptContext, reused bool) string {
	c := ctx.Attempt.Cause
	if reused {
		if c.Kind == "rework" {
			note := ""
			if c.Note != nil {
				note = *c.Note
			}
			return "用户退回了上次的结果，意见：" + note + "\n请按意见修改，完成后照原格式汇报。"
		}
		if c.Answer != nil {
			yes := "不同意"
			if c.Answer.Approve {
				yes = "同意"
			}
			extra := ""
			if c.Answer.Input != nil && *c.Answer.Input != "" {
				extra = "，并补充：" + *c.Answer.Input
			}
			return "用户对你上次停下来请求的回答：" + yes + extra + "。请继续，完成后照原格式汇报。"
		}
		return "上次执行被中断了（应用重启或出错）。先检查工作目录与 git 状态，确认哪些已经做过，不要重复对外动作；然后接着完成任务，照原格式汇报。"
	}
	context := ctx.Task.Title
	if e.d.EventsFor != nil {
		if ev := EventsSection(e.d.EventsFor(ctx.Task.ID, c.EventKey)); ev != "" {
			context += "\n" + ev
		}
	}
	return e.d.BuildPrompt(ctx.Task.Goal, context, "目标里写的结果达成；做不到时说明原因")
}

func runeSlice(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func lastRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[len(r)-n:])
	}
	return s
}

func (e *cliExecutor) Start(ctx AttemptContext) {
	go e.start(ctx)
}

func (e *cliExecutor) start(ctx AttemptContext) {
	t, a, rep, prev := ctx.Task, ctx.Attempt, ctx.Report, ctx.Previous
	if t.Executor.Kind != "cli" || t.Executor.Cli == nil || t.Executor.Cwd == nil {
		return
	}
	ex := t.Executor
	h := e.d.Harness
	tabID := ""
	if prev != nil && prev.Carrier != nil && prev.Carrier.TabID != nil {
		tabID = *prev.Carrier.TabID
	}
	k := a.Cause.Kind
	reused := tabID != "" && h.HasTab(tabID) && !h.TakenOver(tabID) && k != "manual" && k != "schedule" && k != "event"
	var iso *CliIsolation
	if !reused {
		var got CliIsolation
		var err error
		if ex.Isolation != nil && *ex.Isolation == "worktree" {
			got, err = e.d.PrepareIsolation(*ex.Cwd, "task-"+a.ID)
		} else {
			got = CliIsolation{Kind: "shared-cwd", Cwd: *ex.Cwd, SourceCwd: *ex.Cwd}
		}
		if err != nil {
			rep.Failed(TaskError{Code: "prepare_failed", Message: err.Error()})
			return
		}
		iso = &got
		mode := "plan"
		if t.Grant.Level >= 2 {
			mode = "acceptEdits"
		}
		model := ""
		if ex.Model != nil {
			model = *ex.Model
		}
		id, err := h.CreateTab(CliCreateTab{Backend: *ex.Cli, Cwd: got.Cwd, Title: runeSlice(t.Title, 60),
			PermissionMode: mode, Goal: runeSlice(t.Goal, 200), TaskID: t.ID, ModelOverride: model, GithubAccess: GithubAccess(t)})
		if err != nil {
			rep.Failed(TaskError{Code: "prepare_failed", Message: err.Error()})
			return
		}
		tabID = id
		c := Carrier{TabID: ptr(id), Cwd: ptr(got.Cwd), SourceCwd: ptr(got.SourceCwd)}
		if got.WorktreePath != "" {
			c.Worktree = ptr(got.WorktreePath)
		}
		if got.GitRoot != "" {
			c.GitRoot = ptr(got.GitRoot)
		}
		rep.Carrier(c)
	} else {
		rep.Carrier(*prev.Carrier)
	}
	tainted := k == "event"
	run := &cliRun{gen: a.Gen, tabID: tabID, ctx: ctx, pending: map[string]bool{}}
	e.mu.Lock()
	e.runs[t.ID] = run
	e.mu.Unlock()
	off := h.OnEvent(func(ev CliTabEvent) {
		if ev.TabID != tabID {
			return
		}
		rep.Heartbeat()
		if ev.Type != "permission" || ev.ID == "" {
			return
		}
		switch DecidePermission(t.Grant.Level, ev.Kind, ev.Summary, tainted) {
		case "allow":
			h.ReplyPermission(tabID, ev.ID, true)
		case "deny":
			h.ReplyPermission(tabID, ev.ID, false)
		default:
			e.mu.Lock()
			run.pending[ev.ID] = true
			e.mu.Unlock()
			rep.NeedsUser(EventWait{Kind: "approval", RequestID: ptr(ev.ID), Detail: ptr(runeSlice(ev.Summary, 800))})
		}
	})
	var before []string
	if !reused {
		before = e.d.GitChanged(iso.Cwd)
	}
	r, err := h.SendTab(tabID, e.promptFor(ctx, reused))
	off()
	e.mu.Lock()
	if e.runs[t.ID] == run {
		delete(e.runs, t.ID)
	}
	stopped := run.stopped
	e.mu.Unlock()
	if err != nil {
		if h.IsStopped(err) {
			// 用户在标签里接手：交给用户；我们自己停的（取消 / 撤销 / 超时）不再回报
			if !stopped && h.TakenOver(tabID) {
				rep.TakenOver()
			}
			return
		}
		rep.Failed(ClassifyError(err.Error()))
		return
	}
	u := UsageDelta{InputTokens: r.InputTokens, OutputTokens: r.OutputTokens}
	if r.CostUsd != nil {
		u.CostUsd = r.CostUsd
	} else {
		u.CostKnown = ptr(false)
	}
	rep.Usage(u)
	parsed := e.d.ParseReport(r.Text)
	workCwd := *ex.Cwd
	if iso != nil {
		workCwd = iso.Cwd
	} else if prev != nil && prev.Carrier != nil && prev.Carrier.Cwd != nil {
		workCwd = *prev.Carrier.Cwd
	}
	after := e.d.GitChanged(workCwd)
	changed := []string{}
	if after != nil {
		seen := map[string]bool{}
		for _, f := range before {
			seen[f] = true
		}
		inReport := map[string]bool{}
		if parsed != nil {
			for _, f := range parsed.ChangedFiles {
				inReport[f] = true
			}
		}
		for _, f := range after {
			if !seen[f] || inReport[f] {
				changed = append(changed, f)
			}
		}
	} else if parsed != nil {
		changed = append(changed, parsed.ChangedFiles...)
	}
	parts := []string{}
	if parsed != nil {
		parts = append(parts, parsed.Done)
		if parsed.Unfinished != "" {
			parts = append(parts, "没做完的："+parsed.Unfinished)
		}
		if parsed.NeedsUser != "" {
			parts = append(parts, "需要你决定的："+parsed.NeedsUser)
		}
	} else if s := lastRunes(strings.TrimSpace(r.Text), 2000); s != "" {
		parts = append(parts, s)
	}
	summary := strings.Join(parts, "\n")
	if summary == "" {
		summary = "(no report)"
	}
	arts := make([]Artifact, 0, len(changed))
	for _, f := range changed {
		arts = append(arts, Artifact{Kind: "file", Ref: f})
	}
	rep.Completed(AttemptResult{Summary: summary, Artifacts: arts})
}

func (e *cliExecutor) Resume(taskID string, gen int, answer Answer) {
	e.mu.Lock()
	run := e.runs[taskID]
	if run == nil || run.gen != gen || answer.RequestID == nil || !run.pending[*answer.RequestID] {
		e.mu.Unlock()
		return
	}
	delete(run.pending, *answer.RequestID)
	e.mu.Unlock()
	// 标签里的审批还在等（7 天内）：直接回答；已经过期的，按崩溃处理（重试会新开一轮带上回答）
	if !e.d.Harness.ReplyPermission(run.tabID, *answer.RequestID, answer.Approve) {
		run.ctx.Report.Failed(TaskError{Code: "executor_crashed", Message: "permission_expired"})
	}
}

func (e *cliExecutor) Stop(taskID string, gen int, reason string) {
	e.mu.Lock()
	run := e.runs[taskID]
	if run == nil || run.gen != gen {
		e.mu.Unlock()
		return
	}
	run.stopped = true
	e.mu.Unlock()
	e.d.Harness.CancelTab(run.tabID)
}
