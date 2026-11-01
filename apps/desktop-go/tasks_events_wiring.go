package main

// 持续任务的事件源（persistent-tasks §6.2），对应 createCore.ts 里的 tasks.registerSource(...)：
// web / folder 直接可用；github 经连接只读；app 听内核事件。编程助手的 tab-finished 在编排器装好（wireHarness，
// 晚于任务服务启动）后才接上：先把订阅记在 taskCliFinished 里，attach 时再挂到编排器的事件上。
// 编排器的事件回调持 GIL（不可重入），转到新 goroutine 再查标签、交给 hub。

import (
	"context"
	"errors"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledgehandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// cliFinishedBus：编程助手一轮结束（app 事件源 cli.finished）的订阅表
type cliFinishedBus struct {
	mu  sync.Mutex
	fns map[int]func(tasks.CliFinished)
	seq int
}

var taskCliFinished = &cliFinishedBus{fns: map[int]func(tasks.CliFinished){}}

func (b *cliFinishedBus) on(fn func(tasks.CliFinished)) func() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.seq++
	id := b.seq
	b.fns[id] = fn
	return func() {
		b.mu.Lock()
		delete(b.fns, id)
		b.mu.Unlock()
	}
}

func (b *cliFinishedBus) emit(e tasks.CliFinished) {
	b.mu.Lock()
	fns := make([]func(tasks.CliFinished), 0, len(b.fns))
	for _, fn := range b.fns {
		fns = append(fns, fn)
	}
	b.mu.Unlock()
	for _, fn := range fns {
		fn(e)
	}
}

// attach：编排器装好后挂上 tab-finished；任务自己开的标签（delegation.taskId）标成 TaskTab
func (b *cliFinishedBus) attach(o *harness.Orchestrator) {
	if o == nil {
		return
	}
	jsrt.Run(func() {
		o.Events().On("tab-finished", func(v any) {
			e, ok := v.(harness.TabFinished)
			if !ok {
				return
			}
			go func() {
				taskTab := false
				if t := (taskCliHarness{}).tab(e.TabID); t != nil {
					if d, _ := t.Get("delegation").(*util.Obj); d != nil && util.Str(d.Get("taskId")) != "" {
						taskTab = true
					}
				}
				b.emit(tasks.CliFinished{TabID: e.TabID, Title: e.Title, Backend: e.Backend, OK: e.Ok, TaskTab: taskTab})
			}()
		})
	})
}

// registerTaskSources：须在 b8.Start() 之前
func registerTaskSources(b8 *knowledgehandlers.Bundle) {
	ts := b8.Tasks
	ts.RegisterSource(tasks.NewWebSource(tasks.WebSourceDeps{T: i18n.T}))
	ts.RegisterSource(tasks.NewFolderSource(tasks.FolderSourceDeps{T: i18n.T}))
	ts.RegisterSource(tasks.NewGithubSource(tasks.GithubSourceDeps{T: i18n.T,
		Read: func(ctx context.Context, p tasks.GithubReadParams, grant []tasks.ConnectionGrant) (any, error) {
			c := b8.Conns
			if c == nil {
				return nil, errors.New("connections unavailable")
			}
			rp := connections.ReadParams{Endpoint: p.Endpoint, Repo: &p.Repo}
			if p.Since != "" {
				rp.Since = &p.Since
			}
			if p.State != "" {
				rp.State = &p.State
			}
			if p.Branch != "" {
				rp.Branch = &p.Branch
			}
			g := make([]connections.Grant, 0, len(grant))
			for _, x := range grant {
				g = append(g, connections.Grant{ConnectionID: x.ConnectionID, Capabilities: x.Capabilities, Resources: x.Resources})
			}
			return c.GithubRead(ctx, rp, g)
		}}))
	ts.RegisterSource(tasks.NewAppSource(tasks.AppBus{
		OnCliFinished:      taskCliFinished.on,
		OnKnowledgeChanged: b8.OnKBChanged,
	}, tasks.AppSourceDeps{T: i18n.T}))
}
