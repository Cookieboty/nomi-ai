package main

import (
	"context"
	"log"
	"path/filepath"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type historyLog struct{}

func (historyLog) Warn(m string, d ...any) { log.Println(append([]any{"[history] WARN", m}, d...)...) }

// delegateHarness：delegate.Harness ← HarnessOrchestrator。DelegateService 跑在自己的 goroutine 上（D-B7-S2-2），
// 每次进编排器都拿 GIL；SendTab 的 Promise 在锁外等。
type delegateHarness struct{ o *harness.Orchestrator }

func gilErr[T any](fn func() T) (T, error) {
	type res struct {
		v   T
		err error
	}
	r := jsrt.Call(func() (r res) {
		defer func() {
			if x := recover(); x != nil {
				if t, ok := x.(jsrt.JSThrow); ok {
					r.err = t
					return
				}
				panic(x)
			}
		}()
		return res{v: fn()}
	})
	return r.v, r.err
}

func (h delegateHarness) State() *util.Obj         { return jsrt.Call(h.o.State) }
func (h delegateHarness) ListTabs() *util.Obj      { return jsrt.Call(h.o.ListTabs) }
func (h delegateHarness) RecentCwds() []string     { return jsrt.Call(h.o.RecentCwds) }
func (h delegateHarness) AutoApproveEnabled() bool { return jsrt.Call(h.o.AutoApproveEnabled) }
func (h delegateHarness) CreateTab(opts *util.Obj) (*util.Obj, error) {
	return gilErr(func() *util.Obj { return h.o.CreateTab(opts) })
}
func (h delegateHarness) SendTab(id, prompt string) (*util.Obj, error) {
	p, err := gilErr(func() *jsrt.Promise[*util.Obj] { return h.o.SendTab(id, prompt, nil, false) })
	if err != nil {
		return nil, err
	}
	return jsrt.Block(p)
}
func (h delegateHarness) CancelTab(id string) { jsrt.Run(func() { h.o.CancelTab(id) }) }
func (h delegateHarness) CloseTab(id string) error {
	_, err := gilErr(func() *util.Obj { return h.o.CloseTab(id) })
	return err
}

// delegateDesktop：delegate.Desktop ← DesktopService（broker / audit / receiversFor）
type delegateDesktop struct{ s *desktop.Service }

func (d delegateDesktop) WorkspaceOf(cwd any) string { return d.s.Broker.WorkspaceOf(cwd) }
func (d delegateDesktop) Guard(p any, need string, allowMissing bool) desktop.GuardResult {
	return d.s.Broker.Guard(p, need, allowMissing)
}
func (d delegateDesktop) GuardIn(root string, p any, need string, allowMissing bool) desktop.GuardResult {
	return d.s.Broker.GuardIn(root, p, need, allowMissing)
}
func (d delegateDesktop) Authorize(i desktop.AuthorizeInput) desktop.Decision {
	return d.s.Broker.Authorize(i)
}
func (d delegateDesktop) AuthorizeIn(i desktop.AuthorizeInput) desktop.Decision {
	return d.s.Broker.AuthorizeIn(i)
}
func (d delegateDesktop) PermissionMode() string          { return d.s.Broker.PermissionMode() }
func (d delegateDesktop) MarkRead(signal context.Context) { d.s.Broker.MarkRead(signal) }
func (d delegateDesktop) CheckSend(p *desktop.Provider, signal context.Context, what string) string {
	return d.s.Broker.CheckSend(p, signal, what)
}

// ReceiversFor = desktop.receiversFor：有 ctx.provider 用 receiverOf，否则取候选角色的 provider
func (d delegateDesktop) ReceiversFor(p *tools.ToolCallProvider, roles []string) []*desktop.Provider {
	if p != nil {
		return []*desktop.Provider{d.s.ReceiverOf(p.ID, p.BaseURL)}
	}
	return d.s.ReceiversFor(nil, roles)
}
func (d delegateDesktop) AuditAppend(e desktop.AuditEntry, rawArgs any) { d.s.Audit.Append(e, rawArgs) }

var _ delegate.Desktop = delegateDesktop{}
var _ delegate.Harness = delegateHarness{}

// wireCoding 对齐 createCore.ts 的 CliUpdateService / DelegateService / SessionHistoryService 构造
// 与 coding.ts 的 cli.registry/plugin*、cliUpdate.*、delegate.*、history.* 过程。
// 账号（AccountService）提供 history 的 accountLabel / sessionAccount；网关（harnessGateway / servedSession）尚未接入（gw），对应依赖为空（Node 侧可选）；
// history.delete 的 shell.trashItem 端口未落地前按「此处不支持删除」返回。
func wireCoding(router *contract.Router, userData string, plugins *cli.CliPluginHost, d *desktop.Service) {
	o, acc := harnessOrch, harnessAccounts
	var updates *cli.CliUpdateService
	var err error
	jsrt.Run(func() {
		updates, err = cli.NewCliUpdateService(cli.CliUpdateOptions{
			Root: filepath.Join(userData, "cli-update"), Logger: stdLogger{}, Events: hostEvents{router},
			// Windows 上先排空（拆空闲进程，最多等 30 秒让进行中的轮次结束）
			Drain: func(kind string) *jsrt.Promise[int] {
				return jsrt.Async(func() (int, error) {
					o.RestartForUpgrade(kind)
					for i := 0; i < 60 && o.BusyTurns(kind) > 0; i++ {
						jsrt.Sleep(500 * time.Millisecond)
					}
					return o.BusyTurns(kind), nil
				})
			},
			OnUpdated: func(string, string) { plugins.RefreshVersions() },
		})
	})
	if err != nil {
		log.Printf("[desktop-go] cliUpdate: %v", err)
		updates = nil
	}
	dlg := delegate.New(delegate.Deps{
		Root: filepath.Join(userData, "delegate"), Harness: delegateHarness{o}, Desktop: delegateDesktop{d},
		Events: hostEvents{router},
	})
	history := jsrt.Call(func() *cli.SessionHistoryService {
		return cli.NewSessionHistoryService(cli.SessionHistoryDeps{
			Logger: historyLog{},
			OpenKeys: func() map[string]bool {
				m := map[string]bool{}
				for _, k := range o.OpenSessionKeys() {
					m[k] = true
				}
				return m
			},
			OpenTitle: func(b, id, title string) { o.SyncOpenSessionTitle(b, id, title) },
			OpenTab: func(x *util.Obj) cli.HistoryOpenTabResult {
				r := o.OpenHistorySession(x)
				return cli.HistoryOpenTabResult{Tab: r.Get("tab"), Reused: r.Get("reused") == true}
			},
			AccountLabel: func(b, id string) string {
				if acc == nil {
					return ""
				}
				v, err := acc.HistoryAccountLabel(b, id)
				if err != nil {
					panic(rethrow(err))
				}
				l, _ := v.(string)
				return l
			},
			SessionAccount: func(b, id string) *cli.HistoryAccount {
				if acc == nil {
					return nil
				}
				a, err := acc.HistorySessionAccount(b, id)
				if err != nil {
					panic(rethrow(err))
				}
				if a == nil {
					return nil
				}
				id2, _ := a.Get("id").(string)
				l, _ := a.Get("label").(string)
				return &cli.HistoryAccount{ID: id2, Label: l}
			},
			SessionModel: func(b, id string) string {
				m, _ := o.SessionModel(b, id)
				return m
			},
		})
	})
	svc := codinghandlers.CodingServices{
		Plugins:  func() codinghandlers.Plugins { return plugins },
		Delegate: func() codinghandlers.Delegate { return dlg },
		History:  func() codinghandlers.History { return history },
		Updates: func() codinghandlers.Updates {
			if updates == nil {
				return nil
			}
			return updates
		},
	}
	codinghandlers.RegisterCoding(router, svc)
}

// rethrow：账号服务的 JS 异常原样抛回（Node 侧依赖直接抛出）
func rethrow(err error) any {
	if t, ok := err.(jsrt.JSThrow); ok {
		return t
	}
	return jsrt.JSThrow{Name: "Error", Message: err.Error()}
}
