// Nomi 的 Go 版（Go 内核 + Wails v3 外壳），与 apps/desktop-electron 共用同一套视图。说明见 README.md，
// 与 Electron 版的偏差见 docs/design/migrate-2.0.5-go.md。
//
//	NOMI_POC_CTL=127.0.0.1:PORT：测量 / CI 用的控制口（/ctl?op=show-chat|close-chat|hide-mascot|show-mascot|island-test|renderer&v=svg|rive|quit）。
//	NOMI_USER_DATA / NOMI_APP_DATA：覆盖 userData / appData 根（测试与迁移用）。
//	NOMI_DEV_VIEWS：开发态视图改由 Vite 开发服务器提供（pnpm dev:go 设置，见 internal/shell/devviews）。
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	aitools "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	aiproviders "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/airouter"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk/mcpbridge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/assetproto"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mousetrack"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatbg"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledgehandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascothandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mediahandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/startup"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/devviews"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

//go:embed all:frontend/dist
var dist embed.FS

func main() {
	hostports.Stage("main-enter")
	// 文档解析子进程（runParse.ts 的 utilityProcess）：同一可执行文件以 NOMI_PARSE_WORKER=1 拉起
	if parse.IsWorker() {
		parse.WorkerMain()
		return
	}
	if exe, err := os.Executable(); err == nil {
		parse.EnableWorker(exe)
	}
	paths := hostports.Paths{UserDataDir: os.Getenv("NOMI_USER_DATA")}
	userData := paths.UserData()
	if err := os.MkdirAll(userData, 0o700); err != nil {
		log.Fatal(err)
	}
	// LoggerService：最先创建（日志目录 = paths.logs() = userData/logs），各服务共用（deps.Root）
	rootLog := services.NewLogger(services.LoggerOptions{LogDir: filepath.Join(userData, "logs"), Packaged: hostports.IsPackaged})
	deps.Root = rootLog
	// log.Printf（[migrate] / [gateway] / [shell] …）也进日志文件（= 统一用 LoggerService），控制台由 rootLog 输出
	log.SetFlags(0)
	log.SetOutput(rootLog.StdWriter("go"))
	defer rootLog.FlushSync()
	if os.Getenv("NODE_ENV") == "development" {
		rootLog.SetLevel(services.DEBUG)
	}
	// 低优先级启动任务 cleanup-old-logs（delay 1000）
	time.AfterFunc(time.Second, func() { rootLog.CleanOldLogs(7) })
	hostports.Stage("logger-ready")
	// = main.ts loadLoginShellPath：读登录 shell 的 PATH（不阻塞启动；探测 CLI 的异步路径会等它），读完再记住 npm 全局 bin
	// （自定义 prefix 且 shell 里没配 PATH 时也能找到已装的 CLI；稍后再跑，不和启动抢资源）
	go mergeLoginShellPath()
	// D-B11-12：这里只复制 2.0.4 文件（不碰钥匙串）；密钥迁移在看板娘窗口出来后后台跑（secretGate）
	if res, err := migrate.RunFiles(userData); err != nil {
		log.Printf("[migrate] warn: %v", err)
	} else if res.Migrated && !res.Skipped { // Skipped：标记已在，res 是上次迁移读回来的结果，不是这次复制的
		log.Printf("[migrate] copied %d files from %s (chatKeys=%d, secrets pending)", res.FilesCopied, res.From, res.ChatKeysExtracted)
	}

	hostports.Stage("migrate-done")
	router := contract.NewRouter()

	var sh shell.Shell
	bundle := shellhandlers.Install(shellhandlers.Deps{
		UserData: userData,
		Router:   router,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		SystemLangs: hostports.SystemLanguages(),
		// = host.liveWindows（看板娘与对话窗口；sh 在外壳建好之前为 nil）
		LiveWindows: func() int {
			if sh == nil {
				return 0
			}
			n := 0
			for _, k := range []shell.WindowKind{shell.Mascot, shell.Chat} {
				if sh.Visible(k) {
					n++
				}
			}
			return n
		},
		// = appearance.isDark（nativeTheme.shouldUseDarkColors）；外壳建好之前按浅色
		IsDark: func() bool {
			d, ok := sh.(interface{ IsDarkMode() bool })
			return ok && d.IsDarkMode()
		},
	})
	isl := island.New(filepath.Join(userData, "island.json"), mascothandlers.Platform())
	isl.PrimaryDisplay = func() (island.Display, bool) {
		pd, ok := sh.(interface {
			PrimaryDisplay() (shell.Rect, shell.Rect, bool)
		})
		if !ok {
			return island.Display{}, false
		}
		b, w, ok := pd.PrimaryDisplay()
		r := func(x shell.Rect) island.Rect {
			return island.Rect{X: float64(x.X), Y: float64(x.Y), Width: float64(x.Width), Height: float64(x.Height)}
		}
		return island.Display{Bounds: r(b), WorkArea: r(w)}, ok
	}
	i18n.SetLocale(func() string { return bundle.Locale.Get().Locale })
	charSvc := newCharacterService(userData, os.Getenv("NOMI_RESOURCES"), builtinPackDir())
	personaSvc := newPersona(charSvc, router)
	bundle.OnLocaleChange = append(bundle.OnLocaleChange, func() { personaSvc.LocaleChanged() })
	chatBgSvc := chatbg.New(filepath.Join(userData, chatbg.File), filepath.Join(userData, "chat", "images"), chatBgPresetFile(),
		chatbg.Ports{PickFiles: func(title string, fs []chatbg.Filter) ([]string, error) {
			w, _ := sh.(*wailsshell.Wails)
			if w == nil {
				return nil, nil
			}
			wf := make([]wailsshell.SaveFileFilter, 0, len(fs))
			for _, f := range fs {
				wf = append(wf, wailsshell.SaveFileFilter{Name: f.Name, Extensions: f.Extensions})
			}
			return w.PickFiles(title, wf)
		}}, func(k string) string { return i18n.T(k) }, func(st chatbg.State) { router.Emit("chatBg.changed", st) })
	mascotCtl := mascothandlers.Install(mascothandlers.Deps{
		Persona:   personaSvc,
		T:         func(k string) string { return i18n.T(k) },
		ChatBg:    chatBgSvc,
		Router:    router,
		Config:    bundle.Config,
		Settings:  bundle.Settings,
		Character: charSvc,
		Island:    isl,
		Geometry: func() shell.Geometry {
			g, _ := sh.(shell.Geometry)
			return g
		},
		Quit:     func() { sh.Quit() },
		OpenChat: func() { sh.Show(shell.Chat) },
		AppName:  "Nomi",
	})
	// 批次 6：桌面工具 / 工作区（授权、审计、撤销、回收站、提醒、拖入总结）
	home, _ := os.UserHomeDir()
	ports := hostPorts{sh: &sh}
	desktopSvc := desktop.CreateService(userData, desktop.Ports{Home: home, PickDirectory: func(title, button, def string) string {
		dir, _ := ports.PickDir(title, button, def)
		return dir
	}, ClipboardRead: ports.ClipboardRead, ClipboardWrite: ports.ClipboardWrite,
		// = electronPorts.notifications（系统通知；mac 开发态不在 .app 里时不可用，桌面服务退回岛 / 气泡）
		NotifySupported: func() bool {
			n, ok := sh.(shellNotifier)
			return ok && n.NotifySupported()
		},
		ShowNotification: func(title, body string, onClick func()) {
			if n, ok := sh.(shellNotifier); ok {
				n.ShowNotification(title, body, onClick)
			}
		}}, router.EmitTo)
	// = Application desktopWindows（看板娘窗口、对话窗口、临时召回、灵动岛）；外壳建好后才有窗口
	desktopSvc.AttachWindows(desktopWindows(&sh, bundle.Startup, isl))
	desktop.Register(router, desktopSvc)
	desktopSvc.StartReminders()
	// 批次 8：知识库 / 记忆 / 定时 / 本地模型 / 导出 / 扩展。
	// Desktop 用批次 6 的同一个 DesktopService；TODO(batch-4/5): Complete / Gateway 接 AI runtime。
	// createCore complete()：知识库 / 记忆 / 日程的 AI 补全，延迟绑定 ChatFacade（AI runtime 未就绪 → electron.common.ai-service-not-ready）
	var chatFacadeRef atomic.Pointer[facade.Chat]
	complete := func(ctx context.Context, msgs []deps.Msg) (string, error) {
		chatFacade := chatFacadeRef.Load()
		if chatFacade == nil {
			return "", errors.New(i18n.T("electron.common.ai-service-not-ready"))
		}
		role := "chat"
		cm := make([]blm.ChatMessage, 0, len(msgs))
		for _, m := range msgs {
			cm = append(cm, blm.ChatMessage{Role: m.Role, Content: m.Content})
		}
		resp, err := chatFacade.SendMessage(ctx, &facade.ChatStreamOptions{Role: &role, Messages: cm, Signal: ctx.Done()})
		if err != nil {
			return "", err
		}
		return resp.Content, nil
	}
	// D-B8-2：LocalModelService 的 gateway()（createCore: services.gateway ?? null）；网关服务稍后创建，延迟取
	var gatewaySvc *gwstore.Service
	b8 := knowledgehandlers.Wire(knowledgehandlers.WireDeps{
		Gateway: func() local.GatewayLike {
			if gatewaySvc == nil {
				return nil
			}
			return shellhandlers.LocalGateway(gatewaySvc)()
		},
		Complete: complete,
		UserData: userData,
		Router:   router,
		Secrets:  security.NewSecretBox("extensions"),
		Desktop:  knowledgehandlers.DesktopAdapter{S: desktopSvc},
		T:        i18n.T,
		Ports:    ports,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
	})
	b8.Start()
	defer b8.Stop()
	// AIRuntimeBoot：内存 ProviderStore + ProviderService（providers.* 契约过程 + providers.changed）
	providerBox := security.NewSecretBox("providers")
	// GatewayStore：userData/gateway/store.json，格式 / 迁移 / 归档对齐 Node GatewayService.init（D-B4d-5 已消除）
	gatewaySvc = gwstore.NewServiceForUserData(userData, gwstore.NewCipher(providerBox), nil)
	gatewaySvc.Store.SetPresetDeps(gwstore.FindPresetDeps())
	gatewaySvc.AttachRuntime(gwstore.RuntimeDeps{
		Root: filepath.Join(userData, "gateway"), Lazy: true, Env: processEnv(),
		RouteListening: func() bool { return false },
		Broadcast:      func(ev string, p any) { router.Emit(ev, p) },
		EnvProviders:   func() []gwstore.EnvProvider { return shellhandlers.GatewayEnvProviders(processEnv()) },
		OnUsage:        qualityOnUsage,
		// longContextPrice = usage.longContextPrice（UsageService 晚绑定）
		LongContextPrice: usageLongContextPrice,
	})
	// UsageService（createCore new UsageService + start；网关 init 后 autoSync）
	defer wireUsage(router, userData, desktopSvc, gatewaySvc)()
	// D-B11-12：2.0.4 密钥迁移屏障。窗口先出（page-loaded mascot），再迁密钥（唯一一次钥匙串授权框），
	// 之后才 gateway Init（含 EnsurePrivacyKey）+ Start；读密钥的契约过程先等它。被拒 = secretsFailed，当空。
	secretGate := migrate.StartSecrets(userData, security.NewSecretBox("migrate"), security.NewElectronSafeStorage(),
		firstWindowShown(), 10*time.Second, func(r migrate.Result) {
			if err := gatewaySvc.InitAfterMigration(r.SecretsMigrated > 0 || len(r.SecretsFailed) > 0); err != nil {
				log.Printf("[gateway] store init failed: %v", err)
			}
			gatewaySvc.Start()
			hostports.Stage("secrets-ready")
		})
	router.GateBefore(secretGatedPrefixes, secretGate.Wait)
	defer gatewaySvc.Dispose()
	providerSvc, llmRegistry := shellhandlers.NewProviderRuntime(providerBox, processEnv(), nomiUsageRecorder(), func(role string) *aiproviders.GatewayResolution {
		r := gatewaySvc.NomiRoute(role)
		if r == nil {
			return nil
		}
		return &aiproviders.GatewayResolution{BaseURL: r.BaseURL, Token: r.Token, Model: r.Model, Protocol: r.Protocol,
			Receiver: aitools.ToolCallProvider{ID: r.ReceiverID, BaseURL: r.ReceiverBaseURL}, Client: r.Client}
	})
	if providerBox == nil || !providerBox.CanEncrypt() {
		log.Printf("[ai-runtime] warn: 系统安全存储（safeStorage）不可用：provider token 仅做编码保存，未加密。面板中会提示用户。")
	}
	shellhandlers.InstallProviders(router, providerSvc)
	// ToolRegistry（ig ctx 的 ToolRegistryKey）+ MCP 桥（AiSdkMcpPlugin / McpBridgePlugin）+ ext.attach（desktop/plugin.ts）
	toolRegistry := tools.NewInMemory()
	// 画像落 userData/ai-chat/memory/user_profile.json；引导期 export() 同 createAiSdkBooter。
	nowMs := func() float64 { return float64(time.Now().UnixMilli()) }
	userProfile := aifacade.NewProfileStore(aifacade.ProfilePath(userData), nowMs)
	userProfile.Export()
	// 非 MCP 的 ig 工具（parity b7s-igtools）：builtin → preference → companion → kb → mem → delegate → ext；
	// Node 的 MCP 工具在异步 connect 后才注册，排在这些之后
	var aiFacade *aifacade.Facade
	registerIgTools(toolRegistry, userProfile, &aiFacade, b8.KB, b8.Mem, b8.Ext, desktopSvc)
	mcpLog := mcpLogger{}
	mcpSvc := mcpbridge.New(mcpbridge.Options{
		GetRegistry: func() tools.Registry { return toolRegistry },
		Logger:      mcpLog,
		GuardTool:   mcpbridge.GuardFromExt(b8.Ext),
	})
	mcpbridge.Apply(mcpSvc, mcpbridge.PluginConfig{
		Servers:     mcpbridge.ServersFromEnv(os.LookupEnv),
		AutoConnect: mcpbridge.AutoConnectFromEnv(os.LookupEnv),
	}, mcpLog)
	defer mcpSvc.Dispose()
	b8.Ext.Attach(func() extensions.McpRuntime { return mcpbridge.ExtRuntime{S: mcpSvc} }, mcpbridge.ExtRegistry{R: toolRegistry})
	// ChatFacade + AiContractRouter 的 ai.chat.*
	chatFacade := facade.NewChat(facade.Deps{
		LLM:   func() facade.Registry { return airouter.Routed{R: llmRegistry} },
		Tools: func() tools.Registry { return toolRegistry },
		Emit:  airouter.PublishAssistantMessage(router.Emit),
	})
	chatFacadeRef.Store(chatFacade)
	// createCore：desktop.attachRuntime（工具结果接收者 / 摘要补全）+ prepareChat（会话工作区 + 外发检查，D-B5-10）
	desktopSvc.AttachRuntime(shellhandlers.DesktopRuntimeHooks(providerSvc, llmRegistry, gatewaySvc,
		func(ctx context.Context, role string, msgs []blm.ChatMessage) (string, error) {
			resp, err := chatFacade.SendMessage(ctx, &facade.ChatStreamOptions{Role: &role, Messages: msgs, Signal: ctx.Done()})
			if err != nil {
				return "", err
			}
			return resp.Content, nil
		}))
	chatHandlers := airouter.New(airouter.Options{Chat: chatFacade, Logger: deps.StdLogger{Prefix: "[ai-runtime]"},
		PrepareChat: desktopSvc.ChatPrep().PrepareChat})
	chatHandlers.Register(router)
	defer chatHandlers.Dispose()
	// AIClient 门面：ai.sessions / tools / memory / asr / tts / avatar（32 过程，parity b7s-aifacade）。
	aiFacade = aifacade.New(aifacade.Options{Now: nowMs, Tools: toolRegistry, Profile: userProfile, Avatar: true,
		AvatarHost: func(cue *util.Obj) { router.Emit("avatar.event", cue) }, Emit: router.Emit})
	aiFacade.Register(router)
	shellhandlers.InstallGateway(router, gatewaySvc)
	shellhandlers.InstallTerminal(router, shellhandlers.NewGatewayTerminal(userData, gatewaySvc, deps.StdLogger{Prefix: "[gateway]"}))
	// 批次 9：语音输入（voice.*）/ 朗读（tts.*）/ nav.openVoiceSettings
	voiceGateway := func() mediahandlers.GatewayLike {
		if gatewaySvc == nil {
			return nil
		}
		return gatewaySvc
	}
	mediahandlers.Wire(mediahandlers.WireDeps{
		Providers:   mediahandlers.GatewayProviders(voiceGateway),
		Credentials: mediahandlers.GatewayCredentials(voiceGateway),
		UserData:    userData,
		Router:      router,
		Config:      bundle.Config,
		Env:         processEnv(),
		T:           i18n.T,
		Logf:        log.Printf,
		LocalOnly:   func() bool { return desktopSvc.Broker.View().LocalOnly },
		Audit: func(e voice.AuditEvent) {
			desktopSvc.Audit.Append(desktop.AuditEntry{Tool: e.Tool, Decision: e.Decision, Result: e.Result, Ms: e.Ms,
				Source: "voice", Provider: e.Provider}, json.RawMessage(util.Stringify(e.Args)))
		},
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		OpenChatOnceLoaded: func() func(func()) {
			if l, ok := sh.(interface {
				ShowOnceLoaded(shell.WindowKind) func(func())
			}); ok {
				return l.ShowOnceLoaded(shell.Chat)
			}
			if sh != nil {
				sh.Show(shell.Chat)
			}
			return nil
		},
		DefaultWakePhrase: func() string {
			for _, p := range []*character.Pack{charSvc.Resolved(), charSvc.Builtin()} {
				if p != nil {
					if w := util.JSTrim(p.Locales["zh"].WakePhrase); w != "" {
						return w
					}
				}
			}
			return ""
		},
	})
	shellP := installShellProcs(router, userData, &sh, gatewaySvc)
	defer shellP.Diagnostics.CliTrace.FlushSync()
	defer shellP.Quality.Dispose()
	gatewayRequests := wireGatewayRequests(userData, shellP)
	defer gatewayRequests.Dispose()
	cliPlugins, disposeHarness := wireHarness(router, userData, home, ports, gatewaySvc, shellP.Quality)
	wireCoding(router, userData, cliPlugins, desktopSvc, gatewaySvc, toolRegistry)
	defer wireAgents(router, userData, desktopSvc)()
	wireScreenAndPending(router, userData, rootLog, desktopSvc)
	defer disposeHarness()
	log.Printf("[desktop-go] %d contract procedures stubbed (not implemented yet)", procs.Install(router))

	ws := &contract.WSServer{Router: router, Token: contract.NewToken(), Origins: map[string]bool{
		"wails://localhost": true, "wails://wails": true, "http://wails.localhost": true, "wails://wails.localhost": true,
	}}
	if err := ws.Start(); err != nil {
		log.Fatal(err)
	}

	assets, _ := fs.Sub(dist, "frontend/dist")
	frag := url.Values{"ws": {ws.URL}, "token": {ws.Token}}
	ctl := os.Getenv("NOMI_POC_CTL")
	if ctl != "" {
		frag.Set("ctl", ctl)
	}
	// 窗口生命周期：看板娘控制器；用户关掉看板娘窗口 = 退出（WindowManager mainWindow 'close' → requestQuit）；
	// 用户关掉主界面且「关闭主界面时：退出 Nomi」= 退出（shouldQuitOnMainClose）
	var quitting atomic.Bool
	quit := func() {
		if quitting.CompareAndSwap(false, true) {
			sh.Quit()
		}
	}
	onWindow := func(k shell.WindowKind, event string) {
		mascotCtl.WindowEvent(k, event)
		if event != "user-closed" || quitting.Load() {
			return
		}
		switch {
		case k == shell.Mascot:
			quit()
		case k == shell.Chat && bundle.Startup.Get().CloseMain == "quit":
			quit()
		}
	}
	// 视图 = 2.0.4 的 renderer / ai-chat 包（frontend/build.mjs 构建）；灵动岛页由 islandPageMiddleware 生成
	pages := map[shell.WindowKind]string{shell.Mascot: "/mascot/index.html", shell.Chat: "/chat/index.html", shell.Island: islandPagePath}
	sh = wailsshell.New(wailsshell.Config{Assets: assets, Fragment: frag, Pages: pages, MascotSize: mascotCtl.WindowSize, MascotPos: mascotCtl.WindowPosition, OnWindow: onWindow,
		OpenProviderPanel: func() { shellhandlers.OpenProviderPanel(router, func() { sh.Show(shell.Chat) }, "") },
		// = buildAiChatWindow restoreChatBounds / setupAiChatWindowEvents saveBounds（config.chatWindowBounds）
		ChatBounds: func(areas []shell.Rect) shell.SavedChatBounds {
			var saved *shell.SavedChatBounds
			if b := bundle.Config.GetConfig().ChatWindowBounds; b != nil {
				saved = &shell.SavedChatBounds{Rect: shell.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}, Maximized: b.Maximized != nil && *b.Maximized}
			}
			return shell.ChatWindowBounds(saved, areas)
		},
		SaveChatBounds: func(b shell.SavedChatBounds) {
			v := map[string]any{"x": b.X, "y": b.Y, "width": b.Width, "height": b.Height}
			if b.Maximized {
				v["maximized"] = true
			}
			_ = bundle.Config.UpdateConfig(map[string]any{"chatWindowBounds": v})
		},
		// = ThemeService 订阅 appearance.onChange
		OnSystemThemeChanged: bundle.Theme.SystemChanged,
		// 灵动岛页面的收起 / 点击信号（islandPageMiddleware 插入的桥）
		OnPageMessage: func(msg string) {
			// = windowGuards setWindowOpenHandler：http(s) 交给系统浏览器，其余拒绝
			if raw, ok := strings.CutPrefix(msg, viewpage.OpenExternalPrefix); ok {
				if u, err := url.Parse(raw); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
					if err := ports.OpenExternal(u.String()); err != nil {
						log.Printf("[shell] open external failed: %v", err)
					}
				}
				return
			}
			switch msg {
			case "nomi:island:hidden":
				isl.Hidden()
			case "nomi:island:open":
				isl.Opened()
			}
		},
		OnFilesDropped: func(k shell.WindowKind, paths []string) {
			switch k {
			case shell.Mascot:
				// = nomiHostIpc dropFile：只认看板娘窗口，和 Electron 一样只取第一个文件
				desktopSvc.DropFile("mascot", paths[0])
			case shell.Chat:
				// = nomiHost.pathForFile：路径交给对话页按文件名配对（ai-chat services/api.ts 的 nomi:host-files）
				if x, ok := sh.(interface {
					ExecJS(shell.WindowKind, string)
				}); ok {
					b, _ := json.Marshal(paths)
					x.ExecJS(shell.Chat, "window.dispatchEvent(new CustomEvent('nomi:host-files',{detail:"+string(b)+"}))")
				}
			}
		},
		ModelSettingsLabel: i18n.T("electron.common.model-settings"),
		IslandLayout: func() (shell.Rect, string, bool) {
			g, ok := isl.Layout()
			if !ok {
				return shell.Rect{}, "", false
			}
			r := island.IslandWindowRect(g, g.Height)
			return shell.Rect{X: int(r.X), Y: int(r.Y), Width: int(r.Width), Height: int(r.Height)}, islandPagePath, true
		},
		Middleware: devViewsMiddleware(viewPageMiddleware(assets, islandPageMiddleware(isl, assetproto.Middleware(map[string]func(http.ResponseWriter, string){
			// registerChatAssetProtocol：用户图片在 userData/chat，预设在应用资源
			assetproto.ChatAssetScheme: func(w http.ResponseWriter, u string) {
				assetproto.ServeChatAsset(w, filepath.Join(userData, "chat"), chatBgPresetFile(), u)
			},
			// registerCharacterPackProtocol(protocol, () => this.resolved.root)
			assetproto.CharacterPackScheme: func(w http.ResponseWriter, u string) {
				assetproto.ServeCharacterPack(w, charSvc.Root(), u)
			},
		}))))})

	shellP.AttachShell()
	isl.SetHost(islandHost(sh, desktopSvc))

	if ctl != "" {
		go http.ListenAndServe(ctl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/mark" {
				log.Printf("[poc] mascot mark %s", r.URL.Query().Get("n"))
				return
			}
			switch r.URL.Query().Get("op") {
			case "show-chat":
				sh.Show(shell.Chat)
			case "close-chat":
				sh.Destroy(shell.Chat)
			case "show-mascot":
				sh.Show(shell.Mascot)
			case "show-island":
				sh.Show(shell.Island)
			case "island-test": // = island.test（设置页「测试」）：走完整的通知管线
				isl.Test("Nomi", i18n.T("electron.common.this-is-what-an-island-notification-looks-like"))
			case "hide-mascot":
				sh.Destroy(shell.Mascot)
			case "renderer": // 测量用：等同 mascot.setRenderer（写设置 + 广播）
				if v := r.URL.Query().Get("v"); v == "svg" || v == "rive" {
					_, _ = mascotCtl.SetRenderer(v)
				}
			case "quit":
				sh.Quit()
			}
			w.Write([]byte("ok\n"))
		}))
	}

	// 启动偏好（Application.ts）：看板娘按 showMascot 显示；关掉看板娘时保证主界面可达（#55）
	showMascot := bundle.Startup.Get().ShowMascot
	var showMascotMu sync.Mutex
	bundle.OnStartupChange = append(bundle.OnStartupChange, func(st startup.State) {
		showMascotMu.Lock()
		changed := st.ShowMascot != showMascot
		showMascot = st.ShowMascot
		showMascotMu.Unlock()
		if !changed {
			return
		}
		if st.ShowMascot {
			sh.Show(shell.Mascot)
			return
		}
		sh.Destroy(shell.Mascot)
		if !sh.Visible(shell.Chat) {
			sh.Show(shell.Chat)
		}
	})
	if showMascot {
		sh.Show(shell.Mascot)
	}
	// 启动后默认界面（planStartup）：首次引导等看板娘先出来再打开（ONBOARDING_OPEN_DELAY_MS）；defaultView=main 直接打开；
	// 看板娘关着或没有托盘时也打开主界面，避免无界面。测量模式（NOMI_POC_CTL）不自动开，对话由 show-chat 显式打开
	if ctl == "" {
		switch {
		case bundle.Onboarding.ShouldAutoOpen():
			time.AfterFunc(1500*time.Millisecond, func() { sh.Show(shell.Chat) })
		case bundle.Startup.Get().DefaultView == "main", !showMascot, !sh.TrayAvailable():
			sh.Show(shell.Chat)
		}
	}
	// 看板娘窗口的鼠标进出（WindowManager.setupMousePositionTracking）
	if g, ok := sh.(shell.Geometry); ok {
		if wc, ok := sh.(shell.WindowControl); ok {
			go mousetrack.New(mousetrack.Deps{
				Bounds:  func() (shell.Rect, bool) { return g.Bounds(shell.Mascot) },
				Cursor:  wc.CursorPosition,
				Publish: func(ev string) { router.EmitTo(ev, nil, "mascot") },
			}).Run(nil)
		}
	}
	hostports.Stage("app-run")
	if err := sh.Run(); err != nil {
		log.Fatal(err)
	}
}

// builtinPackDir：NOMI_CHARACTER_PACK，否则从可执行文件 / 工作目录向上找仓库里的 characters/nomi
func builtinPackDir() string {
	if v := os.Getenv("NOMI_CHARACTER_PACK"); v != "" {
		return v
	}
	var starts []string
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	for _, d := range starts {
		for i := 0; i < 6; i++ {
			p := filepath.Join(d, "characters", "nomi")
			if _, err := os.Stat(filepath.Join(p, "manifest.json")); err == nil {
				return p
			}
			d = filepath.Dir(d)
		}
	}
	return ""
}

// processEnv：process.env 的快照（键 → 值）
func processEnv() map[string]string {
	m := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			m[kv[:i]] = kv[i+1:]
		}
	}
	return m
}

// islandPagePath：Electron 用 data: URL 装 islandHtml(g)；Wails 窗口只能加载资产服务器上的页面，
// 这里按当前几何现场生成同一份 HTML（页面自带 meta CSP）
const islandPagePath = "/__island.html"

// viewPageMiddleware：视图页面（与 Electron 同一份构建产物）按 Go 宿主改写 CSP、插入 Wails 运行时（viewpage）
func viewPageMiddleware(assets fs.FS, next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	page := viewpage.Middleware(assets, "/mascot/index.html", "/chat/index.html")
	return func(h http.Handler) http.Handler { return page(next(h)) }
}

// devViewsMiddleware：设置了 NOMI_DEV_VIEWS（dev.mjs）时，视图页改由 Vite 开发服务器提供（热更新）
func devViewsMiddleware(next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	v := os.Getenv(devviews.Env)
	if v == "" {
		return next
	}
	targets, err := devviews.Parse(v)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("[dev] views from %s", v)
	dev := devviews.Middleware(targets)
	return func(h http.Handler) http.Handler { return dev(next(h)) }
}

func islandPageMiddleware(isl *island.Service, next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler {
		inner := next(h)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != islandPagePath {
				inner.ServeHTTP(w, r)
				return
			}
			g, ok := isl.Layout()
			if !ok {
				g = island.IslandGeometry("", island.Display{}, "pill")
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(strings.Replace(island.IslandHTML(g), "</body>", islandBridge+"</body>", 1)))
		})
	}
}

// mcpLogger：mcpbridge.Logger（ConsoleRuntimeLogger 的 [mcp] 前缀）
type mcpLogger struct{}

func (mcpLogger) Info(m string, kv ...any)  { log.Println(append([]any{"[mcp]", m}, kv...)...) }
func (mcpLogger) Warn(m string, kv ...any)  { log.Println(append([]any{"[mcp] WARN", m}, kv...)...) }
func (mcpLogger) Error(m string, kv ...any) { log.Println(append([]any{"[mcp] ERROR", m}, kv...)...) }

// 读 / 写密钥（网关 store、供应商 token、语音 key、AI 聊天）的契约过程：2.0.4 密钥迁移完成前先等（D-B11-12）
var secretGatedPrefixes = []string{"gateway.", "providers.", "ai.", "voice.", "tts.", "usage.", "harness.", "cli.", "cliAccount.", "delegate.", "local."}

// firstWindowShown：任一窗口页面加载完（看板娘被设置隐藏时是主窗口）就关闭
func firstWindowShown() <-chan struct{} {
	out := make(chan struct{})
	go func() {
		select {
		case <-hostports.Reached("page-loaded mascot"):
		case <-hostports.Reached("page-loaded chat"):
		case <-hostports.Reached("page-loaded main"):
		}
		close(out)
	}()
	return out
}

// islandBridge：灵动岛页面（Electron 版逐字移植）收起时设 document.title = 'hidden:…'、点击时设 location.hash =
// '#open-…'，Electron 靠 page-title-updated / did-navigate-in-page 收到；Wails 没有这两个事件，这里转成消息。
// 插在 </body> 前，执行时页面自己的脚本已经跑完
const islandBridge = `<script>(() => {
  const post = (m) => { try { (window.webkit && webkit.messageHandlers.external || window.chrome && chrome.webview).postMessage(m); } catch (e) {} };
  let last = document.title;
  new MutationObserver(() => {
    const t = document.title;
    if (t !== last && t.startsWith('hidden:')) post('nomi:island:hidden');
    last = t;
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  addEventListener('hashchange', () => { if (/^#open-/.test(location.hash)) post('nomi:island:open'); });
  // Wails 的 ExecJS 要等页面报 wails:runtime:ready 才执行（平时由 /wails/runtime.js 发）；岛页面的 CSP 是
  // default-src 'none'，不加载运行时，这里在页面脚本（__island）就绪后自己报，否则 show 永远排在队列里
  post('wails:runtime:ready');
})();</script>`

// shellNotifier：外壳的系统通知（wailsshell notify.go）
type shellNotifier interface {
	NotifySupported() bool
	ShowNotification(title, body string, onClick func())
}

// islandHost = IslandService 的窗口操作：显示 / 隐藏 / 释放岛窗口，点击打开对话，免打扰来自日程
func islandHost(sh shell.Shell, desktopSvc *desktop.Service) island.Host {
	execJS, _ := sh.(interface {
		ExecJS(shell.WindowKind, string)
	})
	hider, _ := sh.(interface{ Hide(shell.WindowKind) })
	return island.Host{
		// = ensureWindow（await loadURL）+ prepare / showInactive / play（页面的 show 两步合一）：
		// 新建的窗口等页面加载完再填内容，否则调用落空、岛一直是空的
		Present: func(n island.Notice) error {
			loader, ok := sh.(interface {
				ShowOnceLoaded(shell.WindowKind) func(func())
			})
			if execJS == nil || !ok {
				return errors.New("no ExecJS")
			}
			b, _ := json.Marshal(n)
			run := func() { execJS.ExecJS(shell.Island, "window.__island && window.__island.show("+string(b)+")") }
			if after := loader.ShowOnceLoaded(shell.Island); after != nil {
				after(run)
			} else {
				run()
			}
			return nil
		},
		Hide: func() {
			if hider != nil {
				hider.Hide(shell.Island)
			}
		},
		Destroy:  func() { sh.Destroy(shell.Island) },
		OpenChat: func() { sh.Show(shell.Chat) },
		IsQuiet:  func() bool { return desktopSvc.NotifyPolicy != nil && desktopSvc.NotifyPolicy.Quiet() },
		Warn:     func(msg string, err error) { log.Printf("[island] %s: %v", msg, err) },
	}
}

// desktopWindows = Application 的 desktopWindows：main = 看板娘窗口；mascotHidden = startup.showMascot 关闭；
// summon / release = 看板娘关着时临时建出窗口（桌面工具确认框需要宿主），用完仍是关闭状态就再释放
func desktopWindows(shp *shell.Shell, st *startup.Service, isl *island.Service) *desktop.Windows {
	var summoned atomic.Bool
	sh := func() shell.Shell { return *shp }
	return &desktop.Windows{
		Main: func() bool { return sh() != nil && sh().Visible(shell.Mascot) },
		IsVisible: func() bool {
			if g, ok := sh().(interface {
				Shown(shell.WindowKind) (bool, bool)
			}); ok {
				v, _ := g.Shown(shell.Mascot)
				return v
			}
			return sh().Visible(shell.Mascot)
		},
		ShowInactive: func() { sh().Show(shell.Mascot) },
		OpenChat:     func() { sh().Show(shell.Chat) },
		MascotHidden: func() bool { return !st.Get().ShowMascot },
		SummonMascot: func() {
			if sh().Visible(shell.Mascot) {
				sh().Show(shell.Mascot)
				return
			}
			summoned.Store(true)
			sh().Show(shell.Mascot)
		},
		ReleaseMascot: func() {
			if summoned.CompareAndSwap(true, false) && !st.Get().ShowMascot {
				sh().Destroy(shell.Mascot)
			}
		},
		Island: func(n desktop.IslandNotice) bool {
			return isl.Notify(island.Notice{Kind: n.Kind, Title: n.Title, Body: n.Body, DurationMs: n.DurationMs,
				Endpoint: n.Endpoint, Status: n.Status}, false)
		},
	}
}

func mergeLoginShellPath() {
	p := jsrt.Call(func() *jsrt.Promise[struct{}] {
		return cli.LoadLoginShellPath(func(added []string) {
			cli.ForgetMissingCliBins()
			log.Printf("[cli] merged login shell PATH (%d new dirs)", len(added))
		}, cli.LoadLoginShellPathOpts{})
	})
	_, _ = jsrt.Block(p)
	time.Sleep(3 * time.Second)
	// NpmPrefix 在 jsrt 帧里 Await，RememberCliDir 改的也是 jsrt 里读的状态：都放进 jsrt
	_, _ = jsrt.Block(jsrt.Call(func() *jsrt.Promise[struct{}] {
		return jsrt.Async(func() (struct{}, error) {
			if prefix := cli.DefaultCliProbe.NpmPrefix(); prefix != "" {
				cli.RememberCliDir(cli.NpmPrefixBinDir(prefix, goruntime.GOOS))
			}
			return struct{}{}, nil
		})
	}))
}
