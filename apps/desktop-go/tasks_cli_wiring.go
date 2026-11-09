package main

// 持续任务的编程助手执行（docs/features/scheduling-calendar.md）：tasks.CliHarness ← HarnessOrchestrator，
// 注册 cli 执行者（createCliExecutor）。编排器在任务服务启动之后才装好（wireHarness），这里按调用时的
// harnessOrch 取；还没装好时 Bins 为空 → 准备阶段报「配置变了」。
// 执行者在自己的 goroutine 上跑，进编排器都拿 GIL；编排器的事件回调本身持锁，转到新 goroutine 再交给执行者（锁不可重入）。

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// b8Tasks：持续任务服务（main 里装好后赋值；复用会话时判断上一个任务是否结束）
var b8Tasks *tasks.Service

type taskCliHarness struct{}

func (taskCliHarness) orch() *harness.Orchestrator { return harnessOrch }

func (h taskCliHarness) Bins() map[string]bool {
	out := map[string]bool{}
	o := h.orch()
	if o == nil {
		return out
	}
	bins, _ := jsrt.Call(o.State).Get("bins").(*util.Obj)
	if bins == nil {
		return out
	}
	for _, k := range bins.Keys() {
		v := bins.Get(k)
		out[k] = v != nil && v != false && v != ""
	}
	return out
}

func (h taskCliHarness) CreateTab(c tasks.CliCreateTab) (string, error) {
	o := h.orch()
	if o == nil {
		return "", errors.New("harness not ready")
	}
	opts := util.NewObj("backend", c.Backend, "cwd", c.Cwd, "title", c.Title, "activate", false,
		"permissionMode", c.PermissionMode, "delegation", util.NewObj("goal", c.Goal, "taskId", c.TaskID))
	if c.Project != "" {
		opts.Set("projectId", c.Project)
	}
	if c.GithubAccess {
		opts.Get("delegation").(*util.Obj).Set("githubAccess", true)
	}
	if len(c.SandboxGrants) > 0 {
		opts.Get("delegation").(*util.Obj).Set("sandboxGrants", anyStrings(c.SandboxGrants))
	}
	if c.CallID != "" {
		opts.Get("delegation").(*util.Obj).Set("callId", c.CallID)
	}
	if c.ReuseKey != "" {
		opts.Get("delegation").(*util.Obj).Set("reuseKey", c.ReuseKey)
	}
	if c.ModelOverride != "" {
		opts.Set("modelOverride", c.ModelOverride)
	}
	if c.ReasoningEffort != "" {
		opts.Set("reasoningEffort", c.ReasoningEffort)
	}
	tab, err := gilErr(func() *util.Obj { return o.CreateTab(opts) })
	if err != nil {
		return "", err
	}
	return util.Str(tab.Get("id")), nil
}

func (h taskCliHarness) tab(id string) *util.Obj {
	o := h.orch()
	if o == nil {
		return nil
	}
	tabs, _ := jsrt.Call(o.ListTabs).Get("tabs").([]any)
	for _, t := range tabs {
		if x, ok := t.(*util.Obj); ok && util.Str(x.Get("id")) == id {
			return x
		}
	}
	return nil
}

func (h taskCliHarness) HasTab(id string) bool { return h.tab(id) != nil }

func (h taskCliHarness) TakenOver(id string) bool {
	t := h.tab(id)
	if t == nil {
		return false
	}
	d, _ := t.Get("delegation").(*util.Obj)
	return d != nil && d.Get("takenOver") == true
}

func num(v any) int64 {
	if f, ok := v.(float64); ok {
		return int64(f)
	}
	return 0
}

func (h taskCliHarness) SendTab(id, prompt string) (tasks.CliSendResult, error) {
	o := h.orch()
	if o == nil {
		return tasks.CliSendResult{}, errors.New("harness not ready")
	}
	p, err := gilErr(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, prompt, nil, false) })
	if err != nil {
		return tasks.CliSendResult{}, err
	}
	r, err := jsrt.Block(p)
	if err != nil {
		return tasks.CliSendResult{}, err
	}
	out := tasks.CliSendResult{Text: util.Str(r.Get("text"))}
	if u, _ := r.Get("usage").(*util.Obj); u != nil {
		out.InputTokens, out.OutputTokens = num(u.Get("inputTokens")), num(u.Get("outputTokens"))
		if c, ok := u.Get("costUsd").(float64); ok {
			out.CostUsd = &c
		}
	}
	return out, nil
}

func (h taskCliHarness) CancelTab(id string) {
	if o := h.orch(); o != nil {
		jsrt.Run(func() { o.CancelTab(id) })
	}
}

func (h taskCliHarness) ReplyPermission(tabID, requestID string, allow bool) bool {
	o := h.orch()
	if o == nil {
		return false
	}
	return jsrt.Call(func() bool { return o.ReplyPermission(tabID, requestID, allow, "", "") })
}

func (h taskCliHarness) OnEvent(fn func(tasks.CliTabEvent)) func() {
	o := h.orch()
	if o == nil {
		return func() {}
	}
	return jsrt.Call(func() func() {
		return o.Events().OnOff("event", func(v any) {
			x, _ := v.(*util.Obj)
			if x == nil {
				return
			}
			ev, _ := x.Get("event").(*util.Obj)
			if ev == nil {
				return
			}
			e := tasks.CliTabEvent{TabID: util.Str(x.Get("tabId")), Type: util.Str(ev.Get("type")),
				ID: util.Str(ev.Get("id")), Summary: util.Str(ev.Get("summary")), Kind: util.Str(ev.Get("kind"))}
			go fn(e)
		})
	})
}

func (taskCliHarness) IsStopped(err error) bool {
	var s *harness.StoppedError
	return errors.As(err, &s)
}

// taskCliDeps：编程助手执行者的依赖（worktree / git / 委派提示词与汇报格式复用 delegate）
func taskCliDeps(d *desktop.Service) tasks.CliDeps {
	return tasks.CliDeps{
		Harness: taskCliHarness{},
		PrepareIsolation: func(cwd, key, base string) (tasks.CliIsolation, error) {
			iso, err := delegate.PrepareIsolation(cwd, key, base)
			if err != nil {
				return tasks.CliIsolation{}, err
			}
			return tasks.CliIsolation{Kind: iso.Kind, Cwd: iso.Cwd, SourceCwd: iso.SourceCwd, GitRoot: iso.GitRoot,
				WorktreePath: iso.WorktreePath, BaseBranch: iso.BaseBranch}, nil
		},
		ReleaseIsolation: func(iso tasks.CliIsolation) {
			delegate.ReleaseIsolation(isoHandle(iso), nil)
		},
		Land: func(iso tasks.CliIsolation, files []string, title string) tasks.WorktreeApply {
			return taskApplyWorktree(d)(iso, files, title)
		},
		ReuseKey: taskReuseKey,
		ReuseTab: func(t tasks.Task, cwd, mode string) string {
			key := taskReuseKey(t, cwd)
			o := harnessOrch
			if key == "" || o == nil {
				return ""
			}
			tabs, _ := jsrt.Call(o.ListTabs).Get("tabs").([]any)
			id := delegate.FindReusableTab(tabs, key, float64(time.Now().UnixMilli()), func(prev string) bool {
				return taskBusy(prev)
			})
			if id == "" {
				return ""
			}
			// 带上挑选时的拥有者：并发的另一个任务先领走了这个标签时，RebindDelegation 拒绝，这里改为新建
			del := util.NewObj("goal", runeSlice(t.Goal, 200), "taskId", t.ID, "permissionMode", mode,
				delegate.ExpectTaskIDKey, delegate.ReuseOwner(tabs, id))
			if t.Executor.CallID != nil && *t.Executor.CallID != "" {
				del.Set("callId", *t.Executor.CallID)
			}
			if tasks.GithubAccess(t) {
				del.Set("githubAccess", true)
			}
			if g := tasks.SandboxGrants(t); len(g) > 0 {
				del.Set("sandboxGrants", anyStrings(g))
			}
			if ok, err := gilErr(func() bool { return o.RebindDelegation(id, del) }); err != nil || !ok {
				return ""
			}
			return id
		},
		Claim: func(tabID, root, cwd, priority, label string) {
			delegateClaims.Register(tabID, root, cwd, priority, label)
		},
		Unclaim: func(tabID string, changed []string) ([]string, []string) {
			return delegateClaims.Finish(tabID).Filter(changed)
		},
		GitChanged: delegate.GitChanged,
		BuildPrompt: func(goal, context, doneWhen, outOfScope string) string {
			return delegate.BuildDelegatePrompt(delegate.DelegateBrief{Goal: goal, Context: context, DoneWhen: doneWhen,
				OutOfScope: outOfScope})
		},
		ParseReport: func(text string) *tasks.CliReport {
			r := delegate.ParseDelegateReport(text)
			if r == nil {
				return nil
			}
			out := &tasks.CliReport{Done: util.Str(r.Get("done")), Unfinished: util.Str(r.Get("unfinished")),
				NeedsUser: util.Str(r.Get("needsUser"))}
			files, _ := r.Get("changedFiles").([]any)
			for _, f := range files {
				out.ChangedFiles = append(out.ChangedFiles, util.Str(f))
			}
			return out
		},
		DirOk: func(dir string) bool { return taskDirOk(d, dir) },
	}
}

// taskDirOk：任务的代码目录存在、是用户认可的工作区，或在用户授权过读写的（非本次会话）文件夹里
// （委派派出的任务就在这里做）
func taskDirOk(d *desktop.Service, dir string) bool {
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() || d == nil || d.Broker == nil {
		return false
	}
	if d.Broker.IsKnownWorkspace(dir) {
		return true
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return false
	}
	for _, sc := range d.Broker.Scopes() {
		if sc.Kind != "folder" || sc.Mode != "read-write" || sc.Session {
			continue
		}
		rel, err := filepath.Rel(sc.Path, real)
		if err == nil && (rel == "." || (!strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel))) {
			return true
		}
	}
	return false
}

// taskApplyWorktree：tasks.applyWorktree / 验收通过时的落地（delegate.LandWorktree）：改动少拷回当前工作区，
// 每个目标按用户当前的写授权检查；改动多或拷不回去的提交到新分支；之后拆掉 worktree
func taskApplyWorktree(d *desktop.Service) func(iso tasks.CliIsolation, files []string, title string) tasks.WorktreeApply {
	return func(iso tasks.CliIsolation, files []string, title string) tasks.WorktreeApply {
		r := delegate.LandWorktree(isoHandle(iso), files, title, func(dest string) bool {
			return d != nil && d.Broker != nil && d.Broker.Guard(dest, "write", true).OK
		})
		if r.Kept {
			log.Printf("[tasks] worktree landing failed, kept %s: %s", iso.WorktreePath, r.Err)
		}
		return tasks.WorktreeApply{Applied: r.Apply.Applied, Skipped: r.Apply.Skipped, Conflicted: r.Apply.Conflicted,
			Denied: r.Apply.Denied, Branch: r.Branch}
	}
}

func isoHandle(iso tasks.CliIsolation) *delegate.IsolationHandle {
	return &delegate.IsolationHandle{Kind: iso.Kind, Cwd: iso.Cwd, SourceCwd: iso.SourceCwd, GitRoot: iso.GitRoot,
		WorktreePath: iso.WorktreePath, BaseBranch: iso.BaseBranch}
}

// taskReuseKey：同一种任务的标识：来源对话 + 编程助手 + 目录 + 类型 + 模型 + 思考深度（没有来源对话的不复用）
func taskReuseKey(t tasks.Task, cwd string) string {
	if t.Origin.ConversationID == nil || t.Executor.Cli == nil {
		return ""
	}
	cat, model, effort := "", "", ""
	if t.Category != nil {
		cat = *t.Category
	}
	if t.Executor.Model != nil {
		model = *t.Executor.Model
	}
	if t.Executor.ReasoningEffort != nil {
		effort = *t.Executor.ReasoningEffort
	}
	return delegate.ReuseKey(*t.Origin.ConversationID, *t.Executor.Cli, cwd, cat, model, effort)
}

// taskBusy：委派标签上一个任务还没结束（运行中、等验收、要返工……）就不拿来复用
func taskBusy(id string) bool {
	if b8Tasks == nil {
		return true
	}
	rec := b8Tasks.Runtime.Get(id)
	return rec != nil && !retiredTaskStatus(rec.Task.Status)
}

func runeSlice(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// installedClis：已装好的编程助手（task_propose 的 executor=cli 用）
func installedClis() []string {
	out := []string{}
	for k, ok := range (taskCliHarness{}).Bins() {
		if ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// anyStrings：[]string → JS 数组
func anyStrings(xs []string) []any {
	out := make([]any, 0, len(xs))
	for _, x := range xs {
		out = append(out, x)
	}
	return out
}
