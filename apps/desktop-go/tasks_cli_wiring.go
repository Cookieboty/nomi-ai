package main

// 持续任务的编程助手执行（persistent-tasks §7.2）：tasks.CliHarness ← HarnessOrchestrator，对应 createCore.ts 里
// registerExecutor('cli', createCliExecutor(...))。编排器在任务服务启动之后才装好（wireHarness），这里按调用时的
// harnessOrch 取；还没装好时 Bins 为空 → 准备阶段报「配置变了」。
// 执行者在自己的 goroutine 上跑，进编排器都拿 GIL；编排器的事件回调本身持锁，转到新 goroutine 再交给执行者（锁不可重入）。

import (
	"errors"
	"os"
	"sort"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

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
	if c.GithubAccess {
		opts.Get("delegation").(*util.Obj).Set("githubAccess", true)
	}
	if c.ModelOverride != "" {
		opts.Set("modelOverride", c.ModelOverride)
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
		PrepareIsolation: func(cwd, key string) (tasks.CliIsolation, error) {
			iso, err := delegate.PrepareIsolation(cwd, key)
			if err != nil {
				return tasks.CliIsolation{}, err
			}
			return tasks.CliIsolation{Kind: iso.Kind, Cwd: iso.Cwd, SourceCwd: iso.SourceCwd, GitRoot: iso.GitRoot,
				WorktreePath: iso.WorktreePath}, nil
		},
		GitChanged: delegate.GitChanged,
		BuildPrompt: func(goal, context, doneWhen string) string {
			return delegate.BuildDelegatePrompt(delegate.DelegateBrief{Goal: goal, Context: context, DoneWhen: doneWhen})
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

// taskDirOk：任务的代码目录存在、是用户认可的工作区
func taskDirOk(d *desktop.Service, dir string) bool {
	st, err := os.Stat(dir)
	return err == nil && st.IsDir() && d != nil && d.Broker != nil && d.Broker.IsKnownWorkspace(dir)
}

// taskApplyWorktree：tasks.applyWorktree 的实际拷贝，每个目标按用户当前的写授权检查
func taskApplyWorktree(d *desktop.Service) func(iso tasks.CliIsolation, files []string) tasks.WorktreeApply {
	return func(iso tasks.CliIsolation, files []string) tasks.WorktreeApply {
		r := delegate.ApplyWorktreeToMain(&delegate.IsolationHandle{Kind: iso.Kind, Cwd: iso.Cwd, SourceCwd: iso.SourceCwd,
			GitRoot: iso.GitRoot, WorktreePath: iso.WorktreePath}, files, func(dest string) bool {
			return d != nil && d.Broker != nil && d.Broker.Guard(dest, "write", true).OK
		})
		return tasks.WorktreeApply{Applied: r.Applied, Skipped: r.Skipped, Conflicted: r.Conflicted, Denied: r.Denied}
	}
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
