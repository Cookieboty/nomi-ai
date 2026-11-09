package main

import (
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascothandlers"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/accounts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/codinghandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/quality"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/terminal"
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

// WindowFocus：windows.anyFocused。壳在 *wailsshell.Wails 上实现
// AnyFocused() bool 即自动接上；没实现时按未聚焦处理。
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

// externals：外部插件spec / handshake（握手能力只能收窄注册表能力位）
type externals struct{ h *cli.CliPluginHost }

func (e externals) Spec(id string) *util.Obj { return e.h.ExternalSpec(id) }
func (e externals) Handshake(id string, images, resume bool) {
	e.h.SetHandshake(id, util.NewObj("images", images, "resume", resume))
}

// harnessOrch：wireHarness 构造的编排器（main 里只有一个）
var harnessOrch *harness.Orchestrator

// harnessAccounts：wireHarness 构造的 AccountService（构造失败时为 nil）
var harnessAccounts *accounts.AccountService

// wireHarness：构造 HarnessOrchestrator，注册 harness.* 过程。
// gateway = harnessGateway(gateway)（harness_gateway.go）。
// cwdCheck / envAllow：编程助手的工作目录策略与放行的环境变量（desktop.PermissionBroker）
func wireHarness(router *contract.Router, userData, home string, hp hostPorts, gw *gwstore.Service, q *quality.Service,
	cwdCheck func(dir string) string, envAllow func() []string, sbx *harness.SandboxDeps, projs *projects.Store) (*cli.CliPluginHost, func()) {
	docs := hostports.Documents()
	var o *harness.Orchestrator
	// 编程助手插件宿主（CliPluginHost）
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
				return harness.SpawnHarness(command, args, cwd, harness.CliChildEnv(useNode, nil, envAllow()), ""), nil
			},
			OnExternalRemoved: func(id string) { o.ExternalRemoved(id) },
		})
	})
	// AccountService
	var acc *accounts.AccountService
	jsrt.Run(func() {
		a, err := accounts.NewAccountService(accounts.ServiceDeps{
			Root: filepath.Join(userData, "cli-accounts"), Logger: deps.StdLogger{Prefix: "[cli-accounts]"},
			Events: hostEvents{router},
			OnDefaultChanged: func(kind string) {
				o.RecycleDefaultAccount(kind)
				usageForgetAccountQuota(kind)
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
		accountsRef.Store(a) // usage_wiring.go：grokAccountKey / officialAccount
		harnessAccounts = a  // coding_wiring.go：history 的 accountLabel / sessionAccount
	})
	var accPort ports.HarnessOfficialAccounts
	// AccountLogin（emit = loginBroadcaster → cliAccount.login）
	var login *accounts.AccountLogin
	if acc != nil {
		accPort = accounts.HarnessAdapter{S: acc}
		login = accounts.NewAccountLogin(accounts.LoginDeps{
			Accounts:     acc,
			Emit:         func(e *util.Obj) { router.Emit("cliAccount.login", e) },
			OpenExternal: hp.OpenExternal,
			Logger:       deps.StdLogger{Prefix: "[cli-accounts]"},
		})
	}
	// cliAccount.* 过程
	codinghandlers.RegisterAccounts(router, codinghandlers.AccountServices{
		Accounts: func() codinghandlers.Accounts {
			if acc == nil {
				return nil
			}
			return acc
		},
		Login: func() codinghandlers.AccountLogin {
			if login == nil {
				return nil
			}
			return login
		},
	})
	o = jsrt.Call(func() *harness.Orchestrator {
		return harness.New(harness.Deps{
			Externals: externals{plugins}, Accounts: accPort,
			Gateway: gatewayPort(gw),
			Quality: quality.CliSink{S: q},
			Root:    filepath.Join(userData, "harness"), Logger: stdLogger{}, Home: home,
			DefaultCwd: filepath.Join(docs, "nomi"), LegacyDefaultCwd: docs,
			Ports:          harnessPorts{hp},
			PrewarmClaude:  os.Getenv("NOMI_HARNESS_PREWARM") != "0",
			GrokAcp:        os.Getenv("NOMI_GROK_ACP") != "0",
			CodexAppServer: os.Getenv("NOMI_CODEX_APP_SERVER") != "0",
			CwdCheck:       cwdCheck,
			EnvAllow:       envAllow,
			Sandbox:        sbx,
			ProjectRoots: func(id string) (string, []string) {
				r := projs.Roots(id)
				return r.Primary, r.Extra
			},
			InProject: projs.Contains,
		})
	})
	harnessOrch = o // coding_wiring.go（cliUpdate / history / delegate）共用同一编排器
	projs.OnChange(func(id string) { jsrt.Run(func() { o.ProjectChanged(id) }) })
	codinghandlers.RegisterHarness(router, func() *harness.Orchestrator { return o })
	codinghandlers.RegisterOpenTerminal(router, cwdCheck, terminal.OpenAt)
	jsrt.Go(func() { plugins.Start() })
	return plugins, func() {
		jsrt.Run(func() {
			// lifecycle 'cli-account-login'：退出时结束还在进行的登录
			if login != nil {
				login.Dispose()
			}
			o.Dispose()
		})
	}
}

// gatewayPort：nil 网关 = 没有网关（可选依赖）
func gatewayPort(gw *gwstore.Service) ports.HarnessGateway {
	if gw == nil {
		return nil
	}
	return harnessGateway{gw}
}

// wireNomiBroker：给 desktop.broker 接上编程助手设置。Nomi 对话的权限模式跟输入栏
// （「完全放开」不适用）；工作区只认用户选过的目录（标签目录 / 最近列表 / 默认目录）；「全部自动」
// 跟编程助手设置。broker 的调用方（PrepareChat、工具执行）都在 GIL 外，进编排器要拿 GIL。
func wireNomiBroker(b *desktop.PermissionBroker, o *harness.Orchestrator) {
	b.PermissionMode = func() desktop.PermMode {
		m := jsrt.Call(o.MainPermissionMode)
		if m == "bypass" {
			return "acceptEdits"
		}
		return m
	}
	b.IsKnownWorkspace = func(dir string) bool {
		_, err := gilErr(func() string { return o.KnownDir(dir) })
		return err == nil
	}
	// 对话里的本机图片（CLI 存下的二维码、截图）：在认可的工作区或授权过的文件夹里才读
	dirOk := func(dir string) bool {
		if b.IsKnownWorkspace(dir) {
			return true
		}
		for _, sc := range b.Scopes() {
			if sc.Kind == "folder" && (sc.Path == dir || strings.HasPrefix(dir, strings.TrimSuffix(sc.Path, string(filepath.Separator))+string(filepath.Separator))) {
				return true
			}
		}
		return false
	}
	mascothandlers.LocalImageDirOk.Store(&dirOk)
	// Nomi 自己的「工作区文件操作免确认」（没单独设过时跟随编程助手的「全部自动」）
	b.AutoApprove = func() bool { return jsrt.Call(o.NomiAutoApproveEnabled) }
	b.OnWorkspaceRejected = func(dir, reason string) {
		log.Printf("[desktop] WARN Nomi workspace rejected; tools fall back to granted folders dir=%s reason=%s", dir, reason)
	}
}

// sandboxDeps：编程助手的系统沙箱设置来自桌面权限（受保护文件夹、开关、「始终允许」）
func sandboxDeps(b *desktop.PermissionBroker) *harness.SandboxDeps {
	return &harness.SandboxDeps{
		Enabled:   b.CliSandboxEnabled,
		Protected: b.ProtectedPaths,
		Always: func() []harness.SandboxGrant {
			var out []harness.SandboxGrant
			for _, a := range b.CliSandboxAllow() {
				out = append(out, harness.SandboxGrant{Kind: a.Kind, Value: a.Value, Project: a.Project})
			}
			return out
		},
		Persist: func(g harness.SandboxGrant) {
			b.AddCliSandboxAllow(desktop.SandboxAllow{Kind: g.Kind, Value: g.Value, Project: g.Project})
		},
	}
}

// watchSandboxPolicy：沙箱相关设置（开关、受保护文件夹、「始终允许」）变了：常驻的 CLI 按新配置重开
func watchSandboxPolicy(b *desktop.PermissionBroker, o *harness.Orchestrator) {
	sig := func() string {
		v := b.View()
		return fmt.Sprint(v.CliSandbox, v.ProtectedPaths, v.CliSandboxAllow)
	}
	var mu sync.Mutex
	last := sig()
	b.OnChange(func() {
		next := sig()
		mu.Lock()
		changed := next != last
		last = next
		mu.Unlock()
		if changed {
			jsrt.Go(func() { o.SandboxPolicyChanged() })
		}
	})
}
