package main

import (
	"log"
	"os"
	"path/filepath"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// harnessPorts：HarnessPorts（dialogs.pickDirectory / windows.anyFocused）
type harnessPorts struct{ hp hostPorts }

func (p harnessPorts) PickDirectory(title string, _ bool, def string) *string {
	d, err := p.hp.PickDir(title, "", def)
	if err != nil || d == "" {
		return nil
	}
	return &d
}

// WindowFocus：windows.anyFocused。壳（feat/2.0.5-go-shell）在 *wailsshell.Wails 上实现
// AnyFocused() bool 即自动接上；未实现前按未聚焦处理。
type WindowFocus interface{ AnyFocused() bool }

func (p harnessPorts) AnyFocused() bool {
	if w := p.hp.w(); w != nil {
		if f, ok := any(w).(WindowFocus); ok {
			return f.AnyFocused()
		}
	}
	return false
}

type stdLogger struct{}

func (stdLogger) Info(m string, d any) { log.Printf("[harness] %s %v", m, d) }
func (stdLogger) Warn(m string, d any) { log.Printf("[harness] WARN %s %v", m, d) }

type hostEvents struct{ r *contract.Router }

func (e hostEvents) Publish(ev string, p any) { e.r.Emit(ev, p) }

// externals：外部插件（§5.9）spec / handshake（握手能力只能收窄注册表能力位）
type externals struct{ h *cli.CliPluginHost }

func (e externals) Spec(id string) *util.Obj { return e.h.ExternalSpec(id) }
func (e externals) Handshake(id string, images, resume bool) {
	e.h.SetHandshake(id, util.NewObj("images", images, "resume", resume))
}

// harnessOrch：wireHarness 构造的编排器（main 里只有一个）
var harnessOrch *harness.Orchestrator

// wireHarness 对齐 createCore.ts 的 HarnessOrchestrator 构造 + coding.ts 的 harness.* 过程。
// gateway = harnessGateway(gateway)（harness_gateway.go）。
func wireHarness(router *contract.Router, userData, home string, hp hostPorts, gw *gwstore.Service) (*cli.CliPluginHost, func()) {
	docs := hostports.Documents()
	var o *harness.Orchestrator
	// 编程助手插件宿主（createCore.ts new CliPluginHost）
	plugins := jsrt.Call(func() *cli.CliPluginHost {
		return cli.NewCliPluginHost(cli.CliPluginHostDeps{
			Root: filepath.Join(userData, "cli-plugins"), Logger: stdLogger{}, Events: hostEvents{router},
			Version: func(id string) *jsrt.Promise[*string] {
				return jsrt.Async(func() (*string, error) {
					bin := cli.ResolveCliBinAsync(id)
					if bin == "" {
						return nil, nil
					}
					v := cli.ReadVersionAsync(bin)
					if v == "" {
						return nil, nil
					}
					return &v, nil
				})
			},
			OnVersionChange: func(id, _, _ string) {
				if builtin.IsBuiltinCliID(id) {
					o.RestartForUpgrade(id)
				}
			},
			SpawnExternal: func(command string, args []string, cwd string) (clisdk.ChildLike, error) {
				useNode := harness.IsScript(command)
				if useNode {
					command, args = harness.NodeExecPath(), append([]string{command}, args...)
				}
				return harness.SpawnHarness(command, args, cwd, harness.CliChildEnv(useNode, nil), ""), nil
			},
			OnExternalRemoved: func(id string) { o.ExternalRemoved(id) },
		})
	})
	// AccountService（createCore.ts new AccountService）
	var acc *accounts.AccountService
	jsrt.Run(func() {
		a, err := accounts.NewAccountService(accounts.ServiceDeps{
			Root: filepath.Join(userData, "cli-accounts"), Logger: deps.StdLogger{Prefix: "[cli-accounts]"},
			Events: hostEvents{router},
			OnDefaultChanged: func(kind string) {
				o.RecycleDefaultAccount(kind)
				// usage.forgetAccountQuota：usage 服务尚未移植，落地后接入
			},
			InUse: func(kind, id string) any {
				n := 0.0
				for _, a := range o.OfficialAccountTabs(kind) {
					var ap *string
					if s, ok := a.(string); ok {
						ap = &s
					}
					r, err := acc.Resolve(kind, ap)
					if err != nil {
						panic(jsrt.JSThrow{Name: "Error", Message: err.Error()})
					}
					if r == id {
						n++
					}
				}
				return n
			},
			OnChanged: func() { acc.BroadcastChanged() },
		})
		if err != nil {
			log.Printf("[desktop-go] AccountService: %v", err)
			return
		}
		acc = a
	})
	var accPort ports.HarnessOfficialAccounts
	if acc != nil {
		accPort = accounts.HarnessAdapter{S: acc}
	}
	o = jsrt.Call(func() *harness.Orchestrator {
		return harness.New(harness.Deps{
			Externals: externals{plugins}, Accounts: accPort,
			Gateway: gatewayPort(gw),
			Root:    filepath.Join(userData, "harness"), Logger: stdLogger{}, Home: home,
			DefaultCwd: filepath.Join(docs, "nomi"), LegacyDefaultCwd: docs,
			Ports:          harnessPorts{hp},
			PrewarmClaude:  os.Getenv("NOMI_HARNESS_PREWARM") != "0",
			GrokAcp:        os.Getenv("NOMI_GROK_ACP") != "0",
			CodexAppServer: os.Getenv("NOMI_CODEX_APP_SERVER") != "0",
		})
	})
	harnessOrch = o // coding_wiring.go（cliUpdate / history / delegate）共用同一编排器
	codinghandlers.RegisterHarness(router, func() *harness.Orchestrator { return o })
	jsrt.Go(func() { plugins.Start() })
	return plugins, func() { jsrt.Run(func() { o.Dispose() }) }
}

// gatewayPort：nil 网关 = Node 未传 gateway（可选依赖）
func gatewayPort(gw *gwstore.Service) ports.HarnessGateway {
	if gw == nil {
		return nil
	}
	return harnessGateway{gw}
}
