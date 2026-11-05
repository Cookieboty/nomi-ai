package tasks

// `cli` 执行者：用户装好、配好的编程助手在后台标签里执行任务（docs/features/scheduling-calendar.md）。
// 默认直接在代码目录里改（同仓库并行的任务按文件、按优先级让路）；指定了别的分支做基线时在 worktree 里改，
// 验收（或验收卡片上的回填）时落地：改动少拷回当前工作区，改动多提交到新分支。
// 同一种任务接着用上一次的会话；授权等级换算权限档、审批先过确定性命令分类、用户在标签里接手 → takenOver。

import (
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
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
	// ReasoningEffort：委派带过来的思考深度
	ReasoningEffort string
	// GithubAccess：授权里有 GitHub 对外能力，标签不隔离 gh 登录
	GithubAccess bool
	// ReuseKey：同一种任务的标识（之后同一种任务接着用这个标签的会话）；空 = 不复用
	ReuseKey string
	// CallID：委派任务的来源工具调用 id（对话里的子任务卡片据此找到标签）
	CallID string
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
	Kind         string // worktree | in-place | shared-cwd
	Cwd          string
	SourceCwd    string
	GitRoot      string
	WorktreePath string
	BaseBranch   string
}

// CliReport：[nomi-report] 解析结果
type CliReport struct {
	Done         string
	ChangedFiles []string
	Unfinished   string
	NeedsUser    string
}

type CliDeps struct {
	Harness CliHarness
	// PrepareIsolation：baseBranch 是别的分支时开 worktree，否则直接在 sourceCwd 里改（in-place / shared-cwd）
	PrepareIsolation func(sourceCwd, key, baseBranch string) (CliIsolation, error)
	// ReleaseIsolation：拆掉 worktree：准备好但没用上（准备期间被取消），或任务结束后；可为空
	ReleaseIsolation func(iso CliIsolation)
	// Land：worktree 落地（改动少拷回当前工作区、多则提交到新分支）并拆掉；可为空
	Land func(iso CliIsolation, files []string, title string) WorktreeApply
	// ReuseKey / ReuseTab：同一种任务接着用上一次的会话；ReuseTab 找到并接管了空闲标签时返回它的 id；可为空
	ReuseKey func(t Task, cwd string) string
	ReuseTab func(t Task, cwd, mode string) string
	// Claim / Unclaim：同一仓库里直接改的并行任务按文件、按优先级裁决；Unclaim 返回自己的改动与让出去的文件；可为空
	Claim       func(tabID, gitRoot, cwd, priority, label string)
	Unclaim     func(tabID string, changed []string) (mine, yielded []string)
	GitChanged  func(cwd string) []string // nil = 不在 git 仓库里
	BuildPrompt func(goal, context, doneWhen, outOfScope string) string
	ParseReport func(text string) *CliReport
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
	// preparing：还在准备隔离目录、尚未建标签的执行；Stop 在这里留下取消标记（#234）
	preparing map[string]*cliPrep
	// released：已经拆掉（或交给落地）的 worktree：失败放弃（Release）与任务结束（Retire）可能先后到，只处理一次
	released map[string]bool
}

// claimRelease：这个 worktree 还没处理过就记下并返回 true
func (e *cliExecutor) claimRelease(wt string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.released[wt] {
		return false
	}
	e.released[wt] = true
	return true
}

type cliPrep struct {
	gen       int
	cancelled bool
}

func NewCliExecutor(d CliDeps) Executor {
	return &cliExecutor{d: d, runs: map[string]*cliRun{}, preparing: map[string]*cliPrep{}, released: map[string]bool{}}
}

// prepCancelled：准备是否已被取消 / 撤销 / 换代
func (e *cliExecutor) prepCancelled(id string, p *cliPrep) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return p.cancelled || e.preparing[id] != p
}

func (e *cliExecutor) endPrep(id string, p *cliPrep) {
	e.mu.Lock()
	if e.preparing[id] == p {
		delete(e.preparing, id)
	}
	e.mu.Unlock()
}

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

// GithubAccess：授权里有 GitHub 连接的对外能力（github.read 以外）：标签不隔离 gh 登录（docs/features/scheduling-calendar.md）
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

// DecidePermission：allow 直接放行；ask 停下来等人；deny 授权外，直接拒绝。
// 计划审批一律问人；读凭据 / 合并发布永远问人；对外动作要 L4 + GitHub 对外能力；跑命令要 L3
// （事件触发的任务读过外部内容、或委派时 Nomi 没开「全部自动」：问人）。
func DecidePermission(t Task, kind, summary string, tainted bool) string {
	if kind == "approve-plan" {
		return "ask"
	}
	level := t.Grant.Level
	switch ClassifySummary(summary) {
	case "credential", "never":
		return "ask"
	case "external":
		// 对外命令（git push、gh pr create……）：L4 且授权里有 GitHub 的对外能力才放行（docs/features/scheduling-calendar.md）
		if level >= 4 && GithubAccess(t) {
			return "allow"
		}
		return "ask"
	}
	if level < 3 {
		return "deny"
	}
	if t.Executor.Kind == "cli" && t.Executor.AskCommands != nil && *t.Executor.AskCommands {
		return "ask"
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
	// 用户点名的编程助手不可用：失败并提示，不悄悄换成别的
	if !e.d.Harness.Bins()[*ex.Cli] {
		return ExecutionSnapshot{}, &TaskError{Code: "config_changed", Message: configCliUnavailable(*ex.Cli)}
	}
	if !e.d.DirOk(*ex.Cwd) {
		return ExecutionSnapshot{}, &TaskError{Code: "config_changed", Message: configWorkspaceUnavailable(*ex.Cwd)}
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
	if b := ctx.Task.Executor.Brief; ctx.Task.Executor.Kind == "cli" && b != nil {
		bc, oos := "", ""
		if b.Context != nil {
			bc = *b.Context
		}
		if b.OutOfScope != nil {
			oos = *b.OutOfScope
		}
		return e.d.BuildPrompt(ctx.Task.Goal, bc, b.DoneWhen, oos)
	}
	context := ctx.Task.Title
	if e.d.EventsFor != nil {
		if ev := EventsSection(e.d.EventsFor(ctx.Task.ID, c.EventKey)); ev != "" {
			context += "\n" + ev
		}
	}
	return e.d.BuildPrompt(ctx.Task.Goal, context, "目标里写的结果达成；做不到时说明原因", "")
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
	// 在启动 goroutine 前登记准备态：Stop 可能在 goroutine 跑起来之前就到
	p := &cliPrep{gen: ctx.Attempt.Gen}
	e.mu.Lock()
	e.preparing[ctx.Task.ID] = p
	e.mu.Unlock()
	go e.start(ctx, p)
}

func (e *cliExecutor) start(ctx AttemptContext, p *cliPrep) {
	defer e.endPrep(ctx.Task.ID, p)
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
		if e.d.PrepareIsolation != nil {
			got, err = e.d.PrepareIsolation(*ex.Cwd, "task-"+a.ID, strOr(ex.BaseBranch))
		} else {
			got = CliIsolation{Kind: "shared-cwd", Cwd: *ex.Cwd, SourceCwd: *ex.Cwd}
		}
		if err != nil {
			if !e.prepCancelled(t.ID, p) {
				rep.Failed(TaskError{Code: "prepare_failed", Message: err.Error()})
			}
			return
		}
		// 准备期间被取消 / 撤销 / 换代：不建标签、不发提示词，拆掉没用上的 worktree
		if e.prepCancelled(t.ID, p) {
			if got.Kind == "worktree" && e.d.ReleaseIsolation != nil {
				e.d.ReleaseIsolation(got)
			}
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
		effort := ""
		if ex.ReasoningEffort != nil {
			effort = *ex.ReasoningEffort
		}
		// 同一种任务接着用上一次的会话（worktree 里做的不复用）
		id := ""
		if got.Kind != "worktree" && e.d.ReuseTab != nil {
			id = e.d.ReuseTab(t, got.Cwd, mode)
		}
		if id == "" {
			key := ""
			if got.Kind != "worktree" && e.d.ReuseKey != nil {
				key = e.d.ReuseKey(t, got.Cwd)
			}
			var err error
			id, err = h.CreateTab(CliCreateTab{Backend: *ex.Cli, Cwd: got.Cwd, Title: runeSlice(t.Title, 60),
				PermissionMode: mode, Goal: runeSlice(t.Goal, 200), TaskID: t.ID, ModelOverride: model, ReasoningEffort: effort,
				GithubAccess: GithubAccess(t), CallID: strOr(t.Executor.CallID), ReuseKey: key})
			if err != nil {
				if got.Kind == "worktree" && e.d.ReleaseIsolation != nil {
					e.d.ReleaseIsolation(got)
				}
				rep.Failed(TaskError{Code: "prepare_failed", Message: err.Error()})
				return
			}
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
	// 直接在仓库里改（不是 worktree）：登记，和同仓库并行的任务按文件、按优先级裁决
	claimed := false
	if cr := ctxCarrier(iso, prev, reused); cr.gitRoot != "" && cr.worktree == "" && e.d.Claim != nil && e.d.Unclaim != nil {
		e.d.Claim(tabID, cr.gitRoot, cr.cwd, strOr(t.Priority), runeSlice(t.Title, 40))
		claimed = true
	}
	unclaim := func(changed []string) ([]string, []string) {
		if !claimed {
			return changed, nil
		}
		claimed = false
		return e.d.Unclaim(tabID, changed)
	}
	defer unclaim(nil)
	tainted := a.Cause.FromExternalEvent()
	run := &cliRun{gen: a.Gen, tabID: tabID, ctx: ctx, pending: map[string]bool{}}
	e.mu.Lock()
	if p.cancelled || e.preparing[t.ID] != p {
		e.mu.Unlock()
		return
	}
	delete(e.preparing, t.ID)
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
		switch DecidePermission(t, ev.Kind, ev.Summary, tainted) {
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
	e.mu.Lock()
	stoppedEarly := run.stopped
	e.mu.Unlock()
	if stoppedEarly {
		off()
		e.mu.Lock()
		if e.runs[t.ID] == run {
			delete(e.runs, t.ID)
		}
		e.mu.Unlock()
		return
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
	changed, yielded := unclaim(changed)
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
	if len(yielded) > 0 {
		parts = append(parts, "和并行的任务改到同一个文件，按优先级让给了对方："+strings.Join(yielded, "、"))
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

// Release：失败放弃后 worktree 不会再被用到（失败的执行没有可回填的结果）：拆掉，免得越积越多；
// 用户已接管的标签，worktree 归用户（#118）
func (e *cliExecutor) Release(_ Task, a Attempt) {
	c := a.Carrier
	if c == nil || c.Worktree == nil || *c.Worktree == "" || c.GitRoot == nil || *c.GitRoot == "" || e.d.ReleaseIsolation == nil {
		return
	}
	if c.TabID != nil && *c.TabID != "" && e.d.Harness.TakenOver(*c.TabID) {
		return
	}
	if !e.claimRelease(*c.Worktree) {
		return
	}
	iso := CliIsolation{Kind: "worktree", Cwd: *c.Worktree, SourceCwd: *c.Worktree, GitRoot: *c.GitRoot, WorktreePath: *c.Worktree}
	if c.Cwd != nil && *c.Cwd != "" {
		iso.Cwd = *c.Cwd
	}
	if c.SourceCwd != nil && *c.SourceCwd != "" {
		iso.SourceCwd = *c.SourceCwd
	}
	go e.d.ReleaseIsolation(iso)
}

// Retire：任务结束了（验收通过、取消、过期、失败放弃、删除），执行用过的 worktree 不会再用：
// 验收通过的先落地（改动少拷回当前工作区，多则提交到新分支），其余直接拆；用户接手的标签，worktree 归用户
func (e *cliExecutor) Retire(t Task, attempts []Attempt, accepted bool) {
	if e.d.ReleaseIsolation == nil {
		return
	}
	type job struct {
		iso   CliIsolation
		files []string
		land  bool
	}
	jobs := []job{}
	seen := map[string]bool{}
	for i := len(attempts) - 1; i >= 0; i-- {
		a := attempts[i]
		c := a.Carrier
		if c == nil || c.Worktree == nil || *c.Worktree == "" || c.GitRoot == nil || *c.GitRoot == "" || seen[*c.Worktree] {
			continue
		}
		seen[*c.Worktree] = true
		if c.TabID != nil && *c.TabID != "" && e.d.Harness.TakenOver(*c.TabID) {
			continue
		}
		if !e.claimRelease(*c.Worktree) {
			continue
		}
		iso := CliIsolation{Kind: "worktree", Cwd: *c.Worktree, SourceCwd: *c.Worktree, GitRoot: *c.GitRoot, WorktreePath: *c.Worktree}
		if c.Cwd != nil && *c.Cwd != "" {
			iso.Cwd = *c.Cwd
		}
		if c.SourceCwd != nil && *c.SourceCwd != "" {
			iso.SourceCwd = *c.SourceCwd
		}
		iso.BaseBranch = strOr(t.Executor.BaseBranch)
		j := job{iso: iso}
		// 只有最近一次有结果的执行要落地（更早的已被退回重做，改动就在同一个 worktree 里）
		if accepted && len(jobs) == 0 && a.Result != nil && e.d.Land != nil {
			j.land = true
			for _, art := range a.Result.Artifacts {
				if art.Kind == "file" {
					j.files = append(j.files, art.Ref)
				}
			}
		}
		jobs = append(jobs, j)
	}
	if len(jobs) == 0 {
		return
	}
	go func() {
		for _, j := range jobs {
			if j.land {
				e.d.Land(j.iso, j.files, t.Title)
				continue
			}
			e.d.ReleaseIsolation(j.iso)
		}
	}()
}

func (e *cliExecutor) Stop(taskID string, gen int, reason string) {
	e.mu.Lock()
	if p := e.preparing[taskID]; p != nil && p.gen == gen {
		p.cancelled = true
	}
	run := e.runs[taskID]
	if run == nil || run.gen != gen {
		e.mu.Unlock()
		return
	}
	run.stopped = true
	e.mu.Unlock()
	e.d.Harness.CancelTab(run.tabID)
}

// 配置变了、要用户处理时的说明（任务停到「等你处理」）
func configCliUnavailable(cli string) string {
	return i18n.T("electron.common.task-config-cli-unavailable", cli)
}

func configWorkspaceUnavailable(cwd string) string {
	return i18n.T("electron.common.task-config-workspace-unavailable", cwd)
}

func configNoModel() string { return i18n.T("electron.common.task-config-no-model") }

// strOr：可选字符串取值，nil 为空串
func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

type carrierInfo struct{ gitRoot, cwd, worktree string }

// ctxCarrier：这次执行的载体（新开的取 iso，复用上一次的取它的载体）
func ctxCarrier(iso *CliIsolation, prev *Attempt, reused bool) carrierInfo {
	if iso != nil {
		return carrierInfo{gitRoot: iso.GitRoot, cwd: iso.Cwd, worktree: iso.WorktreePath}
	}
	if reused && prev != nil && prev.Carrier != nil {
		c := prev.Carrier
		return carrierInfo{gitRoot: strOr(c.GitRoot), cwd: strOr(c.Cwd), worktree: strOr(c.Worktree)}
	}
	return carrierInfo{}
}
