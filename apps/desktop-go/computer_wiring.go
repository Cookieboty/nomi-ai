package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/airouter"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/igtools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/computer"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/computer/mcpserve"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// nomiBundleID：packaging/mac/Info.plist.in 的 CFBundleIdentifier
const nomiBundleID = "com.cookieboty.nomi"

// Computer Use：Nomi 自己的 computer_* 工具、给编程助手的 MCP 端点、设置页（computer.*）共用同一个执行器
var (
	computerSvc    *computer.Service
	computerMcpSrv *mcpserve.Server
	// computerGW：视觉兜底经网关调视觉模型（网关在 wireComputer 之后才建好，main 里补上）
	computerGW *gwstore.Service
	// computerWaiting：编程助手标签经 MCP 调用、正在等用户确认的个数（看板上算「等你处理」）
	computerWaiting = struct {
		sync.Mutex
		n map[string]int
	}{n: map[string]int{}}
)

// computerWaitingOf：这个编程助手标签有几个桌面操作在等确认
func computerWaitingOf(tabID string) int {
	computerWaiting.Lock()
	defer computerWaiting.Unlock()
	return computerWaiting.n[tabID]
}

func computerWaitingAdd(tabID string, waiting bool) {
	computerWaiting.Lock()
	if waiting {
		computerWaiting.n[tabID]++
	} else if computerWaiting.n[tabID] > 1 {
		computerWaiting.n[tabID]--
	} else {
		delete(computerWaiting.n, tabID)
	}
	computerWaiting.Unlock()
	if f := fleetSvc.Load(); f != nil {
		f.Changed()
	}
}

// computerVisionModels：设置页可选的视觉模型
func computerVisionModels() []computer.VisionOption {
	out := []computer.VisionOption{}
	if computerGW == nil {
		return out
	}
	for _, m := range computerGW.VisionModels() {
		out = append(out, computer.VisionOption{Ref: m.Ref, Label: m.Label, Provider: m.Provider})
	}
	return out
}

// computerVision：DeskDeps.ComputerVision（设置里选的视觉模型；没选 / 路由不到时 ok = false）
func computerVision() (computer.AskVision, *desktop.Provider, string, bool) {
	if computerSvc == nil || computerGW == nil {
		return nil, nil, "", false
	}
	ref := computerSvc.Settings().VisionModel
	r := computerGW.VisionRoute(ref)
	if r == nil {
		return nil, nil, "", false
	}
	gw, model := computerGW, r.Model
	ask := func(ctx context.Context, prompt string, png []byte) (string, error) {
		return gw.VisionComplete(ctx, model, prompt, png)
	}
	label := ref
	if i := strings.Index(ref, "/"); i >= 0 {
		label = ref[i+1:]
	}
	return ask, &desktop.Provider{ID: r.Receiver.ID, Name: r.Receiver.Name, Local: r.Receiver.Local}, label, true
}

// 紧急停止要停的：Nomi 正在操作桌面的那几轮（airouter 按对话中止）、确认卡（desktop broker）
var (
	computerChats  *airouter.Handlers
	computerBroker *desktop.PermissionBroker
)

// stopComputer：紧急停止（对话窗口的停止条 / 设置页 / 快捷键）：
//   - 取消正在执行的 agent-desktop 命令；正在操作桌面的那一轮之后的调用都拒绝，直到用户发下一条消息；
//   - 中止 Nomi 那几轮对话；编程助手：中止标签当前的一轮，它的 MCP 会话一直拒绝到标签开始下一轮；
//   - 撤掉还在等的桌面操作确认卡
func stopComputer() {
	// 紧急停止也收起还在等的问题卡（Nomi 那一轮随对话中止；编程助手的提问在这里拒绝掉）
	if askBroker != nil {
		askBroker.CancelAll()
	}
	if computerSvc != nil {
		rep := computerSvc.StopAll()
		if computerChats != nil {
			for _, conv := range rep.Conversations {
				computerChats.AbortConversation(conv)
			}
		}
	}
	if computerMcpSrv != nil {
		if tabs := computerMcpSrv.StopAll(); len(tabs) > 0 && harnessOrch != nil {
			o := harnessOrch
			jsrt.Run(func() {
				for _, id := range tabs {
					o.CancelTab(id)
				}
			})
		}
	}
	if computerBroker != nil {
		computerBroker.CancelPendingWhere(func(r desktop.ConfirmRequest) bool { return strings.HasPrefix(r.Tool, "computer_") })
	}
}

// wireComputerHarness：编程助手标签的 MCP 会话跟着标签走：标签关了作废 token；
// 被紧急停止的标签开始下一轮（用户发了新消息，状态从不在跑变成在跑）时解除停止
func wireComputerHarness(o *harness.Orchestrator) {
	if o == nil || computerMcpSrv == nil {
		return
	}
	srv := computerMcpSrv
	prev := map[string]string{}
	jsrt.Run(func() {
		o.Events().On("tabs", func(any) {
			arr, _ := o.ListTabs().Get("tabs").([]any)
			alive := map[string]bool{}
			for _, x := range arr {
				t, _ := x.(*util.Obj)
				if t == nil {
					continue
				}
				id, status := util.JSString(t.Get("id")), util.Str(t.Get("status"))
				alive[id] = true
				if status == "running" && prev[id] != "running" && srv.Stopped(id) {
					srv.Resume(id)
				}
				prev[id] = status
			}
			for id := range prev {
				if !alive[id] {
					delete(prev, id)
				}
			}
			srv.RevokeExcept(alive)
		})
	})
}

// runComputerBridge：`<Nomi> --computer-mcp <token 文件>`：编程助手拉起的 stdio MCP 桥接，不起界面
func runComputerBridge() bool {
	if len(os.Args) < 3 || os.Args[1] != mcpserve.BridgeFlag {
		return false
	}
	os.Exit(mcpserve.Bridge(os.Args[2], os.Stdin, os.Stdout, os.Stderr))
	return true
}

// wireComputer：执行器 + 安装 + 契约过程 + MCP 端点。返回关闭函数
func wireComputer(router *contract.Router, userData string, d *desktop.Service) func() {
	exe, _ := os.Executable()
	self := strings.ToLower(strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe)))
	svc := computer.New(computer.Options{
		Resolve:      resolveAgentDesktop,
		ShotsDir:     filepath.Join(d.Root(), "screenshots"),
		SettingsPath: filepath.Join(d.Root(), "computer.json"),
		Self: func(name, bundleID string) bool {
			n := strings.ToLower(strings.TrimSpace(name))
			return strings.EqualFold(bundleID, nomiBundleID) || n == "nomi" || (self != "" && n == self)
		},
	})
	svc.SetInstaller(computer.InstallDeps{
		Npm:        cli.ResolveNpmBin,
		UserPrefix: cli.UserPrefix,
		CanWrite:   cli.DefaultCliProbe.CanWrite,
		Run:        runWithCliPath,
		NpmPrefix: func() string {
			npm := cli.ResolveNpmBin()
			if npm == "" {
				return ""
			}
			out, code, err := runWithCliPath(context.Background(), []string{npm, "config", "get", "prefix"})
			if err != nil || code != 0 {
				return ""
			}
			lines := strings.Split(strings.TrimSpace(out), "\n")
			return strings.TrimSpace(lines[len(lines)-1])
		},
		Installed: func(prefix string) { cli.RememberCliDir(cli.NpmPrefixBinDir(prefix, "")) },
	})
	computerBroker = d.Broker
	computer.Register(router, svc, computer.RegisterOptions{
		VisionModels:   computerVisionModels,
		Shortcut:       computerHotkeyStatus,
		AutoApprove:    d.Broker.ComputerAlways,
		SetAutoApprove: d.Broker.SetComputerAlways,
		// 停止条 / 设置页的按钮和快捷键走同一个完整流程
		Stop: stopComputer,
	})
	computerSvc = svc

	srv := mcpserve.New(mcpserve.Options{
		Dir: filepath.Join(userData, "harness", harness.ComputerMcpDir),
		Wrap: func(ctx context.Context, label, tabID string) context.Context {
			ctx = igtools.WithRequester(ctx, label)
			return igtools.WithConfirmHook(ctx, func(waiting bool) { computerWaitingAdd(tabID, waiting) })
		},
		Version: hostports.AppVersion,
		// 计划模式（只读）按标签此刻的权限模式判断：长驻的 Codex / ACP 进程切了模式也跟着变
		ReadOnly: func(tabID string) bool {
			o := harnessOrch
			if o == nil {
				return false
			}
			return jsrt.Call(func() bool { return o.PermissionModeOf(tabID) == "plan" })
		},
	})
	if err := srv.Start(); err != nil {
		log.Printf("[computer] mcp endpoint: %v", err)
		return func() {}
	}
	computerMcpSrv = srv
	return srv.Close
}

// computerMcpLaunch：harness.Deps.ComputerMcp。没装 agent-desktop、没打开「允许编程助手使用」时不注入
func computerMcpLaunch(tabID, label string, readOnly bool) *harness.McpLaunch {
	if computerSvc == nil || computerMcpSrv == nil || !computerSvc.Settings().CliEnabled || !computerSvc.Available() {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	if r, e := filepath.EvalSymlinks(exe); e == nil {
		exe = r
	}
	file, err := computerMcpSrv.Launch(tabID, label, readOnly)
	if err != nil {
		log.Printf("[computer] mcp launch: %v", err)
		return nil
	}
	return &harness.McpLaunch{Name: mcpserve.ServerName, Command: exe, Args: []string{mcpserve.BridgeFlag, file}, File: file}
}

// runWithCliPath：带登录 shell PATH 执行命令，返回合并输出与退出码
func runWithCliPath(ctx context.Context, argv []string) (string, int, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	// npm.cmd / 安装命令同样不弹控制台（Computer Use 页打开时会在后台 npm view）
	computer.HideConsole(cmd)
	cmd.Env = usage.EnvSlice(cli.WithCliPath(nil))
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return out.String(), ee.ExitCode(), nil
	}
	if err != nil {
		return out.String(), -1, err
	}
	return out.String(), 0, nil
}

// resolveAgentDesktop：NOMI_AGENT_DESKTOP → 安装包 resources/agent-desktop/ → 用户装的（npm / brew，含 GUI 进程拿不到的 shell PATH）
func resolveAgentDesktop() string {
	name := "agent-desktop"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	exists := func(p string) bool {
		fi, err := os.Stat(p)
		return err == nil && !fi.IsDir()
	}
	if p := os.Getenv("NOMI_AGENT_DESKTOP"); p != "" && exists(p) {
		return p
	}
	if res := os.Getenv("NOMI_RESOURCES"); res != "" {
		if p := filepath.Join(res, "agent-desktop", name); exists(p) {
			return p
		}
	}
	return cli.FindOnPath("agent-desktop", cli.WithCliPath(nil), "", nil)
}

// 紧急停止的系统级快捷键：别的应用在前台（正被操作）时也能按
var computerHotkey struct {
	sync.Mutex
	accel string // 当前注册上的
	err   string // 上次注册失败的原因
}

// wireComputerHotkey：外壳支持系统级快捷键时注册紧急停止，设置改了重新注册
func wireComputerHotkey(sh shell.Shell) {
	gs, ok := sh.(shell.GlobalShortcuts)
	if !ok || computerSvc == nil {
		return
	}
	apply := func(st computer.Settings) {
		computerHotkey.Lock()
		defer computerHotkey.Unlock()
		want := st.EffectiveStopShortcut()
		if want == computerHotkey.accel && computerHotkey.err == "" {
			return
		}
		if computerHotkey.accel != "" {
			_ = gs.UnregisterGlobalShortcut(computerHotkey.accel)
			computerHotkey.accel = ""
		}
		computerHotkey.err = ""
		if want == "" {
			return
		}
		if err := gs.RegisterGlobalShortcut(want, stopComputer); err != nil {
			computerHotkey.err = err.Error()
			log.Printf("[computer] stop shortcut %s: %v", want, err)
			return
		}
		computerHotkey.accel = want
	}
	apply(computerSvc.Settings())
	computerSvc.OnSettingsChange(apply)
}

// computerHotkeyStatus：设置页显示的快捷键（注册上的）与失败原因
func computerHotkeyStatus() (string, string) {
	computerHotkey.Lock()
	defer computerHotkey.Unlock()
	return computerHotkey.accel, computerHotkey.err
}
