package codinghandlers

// coding.ts 中 cli.registry/plugin*、cliUpdate.*、delegate.*、history.* 一节：每个过程委派给服务的公开方法，
// 服务在调用时由 getter 读取，缺了报 UNAVAILABLE（= need('<name>')）。

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Plugins = CliPluginHost 的公开面
type Plugins interface {
	Snapshot() *util.Obj
	AddExternal(raw any) *util.Obj
	RemoveExternal(id string) bool
	TestExternalInTemp(raw any) *jsrt.Promise[*util.Obj]
}

// Updates = CliUpdateService 的公开面
type Updates interface {
	Inspect(refresh bool) *jsrt.Promise[[]*util.Obj]
	PreviewUpdate(kind, scope string) *jsrt.Promise[*util.Obj]
	Run(kind, scope string) *jsrt.Promise[*util.Obj]
	Job(kind string) *util.Obj
	BusyKinds() []string
	DismissJob(kind string) bool
	Environment() *util.Obj
}

// Delegate = DelegateService 的公开面（Pin 返回 "" = null）
type Delegate interface {
	Settings() *util.Obj
	SetSettings(raw any) (*util.Obj, error)
	Pin(name, turnID any) (string, error)
	ClearPin(turnID any)
	StatusOf(taskID string) *util.Obj
}

// History = SessionHistoryService 的公开面
type History interface {
	List(backend string, o cli.HistoryPageOpts) *jsrt.Promise[*util.Obj]
	Index(backend string, o cli.HistoryPageOpts) *jsrt.Promise[*util.Obj]
	Open(backend, sessionID string) *jsrt.Promise[*util.Obj]
	Remove(backend, sessionID string) *jsrt.Promise[*util.Obj]
}

var (
	_ Plugins  = (*cli.CliPluginHost)(nil)
	_ Updates  = (*cli.CliUpdateService)(nil)
	_ Delegate = (*delegate.Service)(nil)
	_ History  = (*cli.SessionHistoryService)(nil)
)

// CodingServices：getter 返回 nil（无类型）= 服务不可用
type CodingServices struct {
	Plugins  func() Plugins
	Updates  func() Updates
	Delegate func() Delegate
	History  func() History
}

func need[T any](get func() T, name string) T {
	var v T
	if get != nil {
		v = get()
	}
	if any(v) == nil {
		panic(&contract.Error{Code: "UNAVAILABLE", Message: "Service '" + name + "' is not available"})
	}
	return v
}

// gil：在 jsrt.Async 帧里跑 f，路由 goroutine 用 jsrt.Block 等（同 harness.go 的 call）
func gil(r *contract.Router, name string, f func(a in) any) {
	r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
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

// plain：不进 GIL 直接调用（DelegateService 在 Go 侧是 goroutine + 锁实现，D-B7-S2-2；
// 它回调编排器时自己 jsrt.Call，若在 GIL 帧里调用会自锁）。panic(JSThrow) = 抛错。
func plain(r *contract.Router, name string, f func(a in) any) {
	r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (v any, err error) {
		defer func() {
			if x := recover(); x != nil {
				switch e := x.(type) {
				case *contract.Error:
					v, err = nil, e
				case jsrt.JSThrow:
					v, err = nil, errors.New(e.Message)
				default:
					panic(x)
				}
			}
		}()
		return f(parse(raw)), nil
	})
}

func throwIf(err error) {
	if err != nil {
		panic(jsrt.JSThrow{Message: err.Error()})
	}
}

// pageOpts = options ?? {}：offset / limit 为数字时生效，force 取 Boolean(o.force)
func pageOpts(v any) cli.HistoryPageOpts {
	o := util.AsObj(v)
	if o == nil {
		return cli.HistoryPageOpts{}
	}
	num := func(k string) *float64 {
		if n, ok := o.Get(k).(float64); ok {
			return &n
		}
		return nil
	}
	return cli.HistoryPageOpts{Offset: num("offset"), Limit: num("limit"), Force: util.Truthy(o.Get("force"))}
}

// RegisterCoding 挂上 cli.registry/plugin*、cliUpdate.*、delegate.*、history.*
func RegisterCoding(r *contract.Router, s CodingServices) {
	plugins := func() Plugins { return need(s.Plugins, "cliPlugins") }
	updates := func() Updates { return need(s.Updates, "cliUpdate") }
	dlg := func() Delegate { return need(s.Delegate, "delegate") }
	history := func() History { return need(s.History, "history") }

	// ── cli：插件注册表 ──
	gil(r, "cli.registry", func(in) any { return plugins().Snapshot() })
	gil(r, "cli.pluginAdd", func(a in) any { return plugins().AddExternal(a.any("spec")) })
	gil(r, "cli.pluginRemove", func(a in) any { return plugins().RemoveExternal(a.str("id")) })
	gil(r, "cli.pluginTest", func(a in) any { return await(plugins().TestExternalInTemp(a.any("spec"))) })

	// ── cliUpdate：安装 / 更新 ──
	gil(r, "cliUpdate.inspect", func(a in) any { return await(updates().Inspect(a.is("refresh"))) })
	gil(r, "cliUpdate.preview", func(a in) any {
		return await(updates().PreviewUpdate(cli.ToUpdatable(a.any("kind")), cli.ToScope(a.any("scope"))))
	})
	gil(r, "cliUpdate.run", func(a in) any {
		return await(updates().Run(cli.ToUpdatable(a.any("kind")), cli.ToScope(a.any("scope"))))
	})
	gil(r, "cliUpdate.job", func(a in) any { return updates().Job(cli.ToUpdatable(a.any("kind"))) })
	gil(r, "cliUpdate.busy", func(in) any { return updates().BusyKinds() })
	gil(r, "cliUpdate.environment", func(in) any { return updates().Environment() })
	gil(r, "cliUpdate.dismiss", func(a in) any { return updates().DismissJob(cli.ToUpdatable(a.any("kind"))) })

	// ── delegate：委派 ──
	plain(r, "delegate.settings", func(in) any { return dlg().Settings() })
	plain(r, "delegate.setSettings", func(a in) any {
		v, err := dlg().SetSettings(a.any("settings"))
		throwIf(err)
		return v
	})
	plain(r, "delegate.pin", func(a in) any {
		v, err := dlg().Pin(a.any("cli"), a.any("turnId"))
		throwIf(err)
		if v == "" {
			return nil
		}
		return v
	})
	plain(r, "delegate.clearPin", func(a in) any {
		dlg().ClearPin(a.any("turnId"))
		return true
	})
	plain(r, "delegate.status", func(a in) any { return dlg().StatusOf(a.str("taskId")) })

	// ── history：CLI 会话记录 ──
	gil(r, "history.list", func(a in) any { return await(history().List(a.str("backend"), pageOpts(a.any("options")))) })
	gil(r, "history.index", func(a in) any { return await(history().Index(a.str("backend"), pageOpts(a.any("options")))) })
	gil(r, "history.open", func(a in) any { return await(history().Open(a.str("backend"), a.str("sessionId"))) })
	gil(r, "history.delete", func(a in) any { return await(history().Remove(a.str("backend"), a.str("sessionId"))) })
}
