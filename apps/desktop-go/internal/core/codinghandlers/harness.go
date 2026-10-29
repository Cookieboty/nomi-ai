// Package codinghandlers = packages/core/src/contract/coding.ts 中编排器（harness.*）一节：
// 每个过程委派给 HarnessOrchestrator 的公开方法。编排器不在时报 UNAVAILABLE（= need()）。
// 编排器代码跑在 jsrt 的 GIL 下：每次调用在一个 jsrt.Async 帧里执行（异步方法在帧内 Await），
// 路由的 goroutine 用 jsrt.Block 等结果——同 Node 里 handler 返回 Promise。
package codinghandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/gemini"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// RouterEvents 把编排器推送接到应用事件总线（events.publish(channel, payload, {surface})）。
type RouterEvents struct{ R *contract.Router }

func (e RouterEvents) Publish(ch string, payload any, surface string) {
	e.R.EmitTo(ch, payload, surface)
}

type in struct{ o *util.Obj }

func parse(raw json.RawMessage) in {
	v, _ := util.Parse(raw)
	o := util.AsObj(v)
	if o == nil {
		o = util.NewObj()
	}
	return in{o}
}
func (a in) any(k string) any { return a.o.Get(k) }
func (a in) str(k string) string {
	s, _ := a.o.Get(k).(string)
	return s
}
func (a in) is(k string) bool { return a.o.Get(k) == true }
func (a in) strP(k string) *string {
	if s, ok := a.o.Get(k).(string); ok {
		return &s
	}
	return nil
}
func (a in) list(k string) []any {
	l, _ := a.o.Get(k).([]any)
	return l
}

// slim = slimResult：去掉逐条事件。
func slim(r *util.Obj) any {
	if r == nil {
		return nil
	}
	c := r.Clone()
	c.Delete("events")
	return c
}

func await[T any](p *jsrt.Promise[T]) T {
	v, err := jsrt.Await(p)
	if err != nil {
		panic(jsrt.JSThrow{Message: err.Error()})
	}
	return v
}

func trust(r *gemini.TrustResult) any {
	if r == nil {
		return nil
	}
	var prev any
	if r.Previous != nil {
		prev = *r.Previous
	}
	return util.NewObj("folder", r.Folder, "file", r.File, "previous", prev)
}

// RegisterHarness 挂上 harness.* 过程（get 返回 nil = 服务不可用）。
func RegisterHarness(r *contract.Router, get func() *harness.Orchestrator) {
	var attached *harness.Orchestrator
	h := func() *harness.Orchestrator {
		o := get()
		if o == nil {
			panic(&contract.Error{Code: "UNAVAILABLE", Message: "Service 'harness' is not available"})
		}
		if attached != o {
			o.AttachEvents(RouterEvents{r})
			attached = o
		}
		return o
	}
	if get() != nil {
		jsrt.Run(func() { h() })
	}
	call := func(name string, f func(a in) any) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (res any, err error) {
			a := parse(raw)
			var cerr error
			p := jsrt.Call(func() *jsrt.Promise[any] {
				return jsrt.Async(func() (v any, e error) {
					defer func() {
						if x := recover(); x != nil {
							if ce, ok := x.(*contract.Error); ok {
								cerr = ce
								return
							}
							panic(x)
						}
					}()
					return f(a), nil
				})
			})
			v, err := jsrt.Block(p)
			if cerr != nil {
				return nil, cerr
			}
			return v, err
		})
	}

	// ── 主标签 ──
	call("harness.state", func(in) any { return h().StateFresh() })
	call("harness.setBackend", func(a in) any { return h().SetBackend(a.any("backend")) })
	call("harness.setCwd", func(a in) any { return h().SetCwd(a.str("cwd"), a.is("carry")) })
	call("harness.pickCwd", func(in) any { return await(h().PickCwd()) })
	call("harness.send", func(a in) any { return slim(await(h().Send(a.str("prompt")))) })

	// ── 标签 ──
	call("harness.tabs", func(in) any { return h().ListTabs() })
	call("harness.tabCreate", func(a in) any { return h().CreateTab(a.o) })
	call("harness.tabSeed", func(a in) any { return h().SeedTabMessages(a.str("id"), a.list("messages")) })
	call("harness.tabClose", func(a in) any { return h().CloseTab(a.str("id")) })
	call("harness.tabRename", func(a in) any { return h().RenameTab(a.str("id"), a.any("title")) })
	call("harness.tabActivate", func(a in) any { return h().SetActiveTab(a.str("id")) })
	call("harness.tabBackend", func(a in) any { return h().SetTabBackend(a.str("id"), a.any("backend")) })
	call("harness.tabCwd", func(a in) any { return h().SetTabCwd(a.str("id"), a.str("cwd"), a.is("carry")) })
	call("harness.tabPermissionMode", func(a in) any {
		opts := harness.PermOpts{Confirmed: a.is("confirmed")}
		if e := util.AsObj(a.any("expect")); e != nil {
			x := in{e}
			opts.Expect = &struct{ Backend, Cwd *string }{x.strP("backend"), x.strP("cwd")}
		}
		return await(h().ApplyTabPermissionMode(a.str("id"), a.any("mode"), opts))
	})
	call("harness.permissionDefaults", func(a in) any {
		return h().SetPermissionDefaults(a.any("defaultPermissionMode"), a.any("codexNetwork"), a.any("autoApprove"))
	})
	call("harness.modelCatalog", func(a in) any {
		src := "official"
		if a.any("source") == "thirdParty" {
			src = "thirdParty"
		}
		return await(h().ModelCatalogFor(a.str("backend"), a.is("refresh"), src))
	})
	call("harness.tabSource", func(a in) any { return h().SetTabSource(a.str("id"), a.any("source"), a.strP("model")) })
	call("harness.tabModel", func(a in) any { return h().SetTabModel(a.str("id"), a.str("model"), a.str("expectSource")) })
	call("harness.tabAccount", func(a in) any {
		id := a.strP("accountId")
		if id != nil && *id == "" {
			id = nil
		}
		return h().SetTabAccount(a.str("id"), id)
	})
	call("harness.tabLongContext", func(a in) any {
		var on *bool
		if b, ok := a.any("on").(bool); ok {
			on = &b
		}
		return h().SetTabLongContext(a.str("id"), on)
	})
	call("harness.tabEffort", func(a in) any { return h().SetTabReasoningEffort(a.str("id"), a.any("effort")) })
	call("harness.tabPickCwd", func(a in) any { return await(h().PickTabCwd(a.str("id"))) })
	call("harness.tabCarryClear", func(a in) any { return h().ClearTabCarry(a.str("id")) })
	call("harness.tabRewind", func(a in) any { return await(h().RewindTab(a.str("id"), a.str("messageId"))) })
	call("harness.pickDir", func(a in) any { return h().PickDirectory(a.str("defaultPath")) })
	call("harness.recentCwds", func(in) any { return h().RecentCwds() })
	call("harness.tabMessages", func(a in) any { return h().TabMessages(a.str("id")) })
	call("harness.tabSend", func(a in) any {
		return slim(await(h().SendTab(a.str("id"), a.str("prompt"), a.list("images"), true)))
	})
	call("harness.tabCancel", func(a in) any { return h().CancelTab(a.str("id")) })
	call("harness.stopAgent", func(a in) any { return h().StopAgent(a.str("id"), a.str("agentId")) })
	call("harness.tabContext", func(a in) any { return await(h().TabContext(a.str("id"))) })

	// ── 斜杠命令 / 改动 / 工作区文件 ──
	call("harness.slashDiscover", func(a in) any { return h().SlashDiscoverIn(a.any("backend"), a.any("cwd")) })
	call("harness.slashExpand", func(a in) any {
		return h().SlashExpandIn(a.any("backend"), a.any("cwd"), a.any("id"), a.any("args"))
	})
	call("harness.gitDiff", func(a in) any { return h().GitDiffIn(a.any("cwd")) })
	call("harness.gitBranch", func(a in) any { return h().GitBranchIn(a.any("cwd")) })
	call("harness.gitSyncStatus", func(a in) any { return h().GitSyncStatusIn(a.any("cwd")) })
	call("harness.gitStage", func(a in) any { return h().GitStageIn(a.any("cwd"), a.any("paths")) })
	call("harness.gitUnstage", func(a in) any { return h().GitUnstageIn(a.any("cwd"), a.any("paths")) })
	call("harness.gitCommit", func(a in) any { return h().GitCommitIn(a.any("cwd"), a.any("message"), a.any("paths")) })
	call("harness.gitCommitUndo", func(a in) any { return h().GitCommitUndoIn(a.any("cwd"), a.any("sha")) })
	call("harness.gitFetch", func(a in) any { return h().GitFetchIn(a.any("cwd")) })
	call("harness.gitPull", func(a in) any { return h().GitPullIn(a.any("cwd")) })
	call("harness.gitPush", func(a in) any { return h().GitPushIn(a.any("cwd")) })
	call("harness.gitDiscard", func(a in) any { return h().GitDiscardIn(a.any("cwd"), a.any("paths")) })
	call("harness.gitDiscardUndo", func(a in) any { return h().GitDiscardUndoIn(a.any("cwd"), a.any("stashes")) })
	call("harness.gitSuggestMessage", func(a in) any { return h().SuggestCommitMessage(a.any("cwd"), a.any("paths")) })
	call("harness.gitWorktrees", func(a in) any { return h().ListWorktrees(a.any("cwd")) })
	call("harness.workspaceList", func(a in) any { return h().WorkspaceListIn(a.any("cwd")) })
	call("harness.workspaceRead", func(a in) any { return h().WorkspaceReadIn(a.any("cwd"), a.any("path")) })
	call("harness.workspaceWrite", func(a in) any {
		return h().WorkspaceWriteIn(a.any("cwd"), a.any("path"), a.any("content"))
	})
	call("harness.workspaceDelete", func(a in) any { return h().WorkspaceDeleteIn(a.any("cwd"), a.any("path")) })
	call("harness.workspaceGitCheckout", func(a in) any {
		return h().WorkspaceGitCheckoutIn(a.any("cwd"), a.any("path"))
	})

	// ── 回答确认 ──
	call("harness.geminiTrustFolder", func(a in) any {
		return trust(await(h().TrustGeminiFolder(a.str("tabId"), a.str("messageId"), a.is("confirmed"))))
	})
	call("harness.replyPermission", func(a in) any {
		return h().AnswerPermission(a.str("tabId"), a.str("requestId"), a.is("allow"), a.any("approvePlan"))
	})
	call("harness.replyApprovePlan", func(a in) any {
		return h().AnswerApprovePlan(a.str("tabId"), a.str("requestId"), a.any("choice"))
	})
}
