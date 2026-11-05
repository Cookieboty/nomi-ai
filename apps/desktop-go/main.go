// Nomi 桌面应用（Go 内核 + Wails v3 外壳），视图是 packages/renderer 与 packages/ai-chat 的构建产物。
// 说明见 README.md 与 docs/development/architecture.md。
//
//	NOMI_POC_CTL=127.0.0.1:PORT：测量 / CI 用的控制口（/ctl?op=show-chat|close-chat|hide-mascot|show-mascot|island-test|renderer&v=svg|rive|quit）。
//	NOMI_USER_DATA / NOMI_APP_DATA：覆盖 userData / appData 根（测试与迁移用）。
//	NOMI_DEV_VIEWS：开发态视图改由 Vite 开发服务器提供（pnpm dev:go 设置，见 internal/shell/devviews）。
//	NOMI_PPROF=127.0.0.1:PORT：在回环地址提供 /debug/pprof/（排查内存 / CPU，见 pprof.go）。
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
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/delegate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/igtools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/characterassets"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatassets"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatbg"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledgehandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascothandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mediahandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/persona"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/providerlink"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/startup"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tray"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/devviews"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/hostdrop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/trash"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

//go:embed all:frontend/dist
var dist embed.FS

func main() {
	hostports.Stage("main-enter")
	// 文档解析子进程：同一可执行文件以 NOMI_PARSE_WORKER=1 拉起
	if parse.IsWorker() {
		parse.WorkerMain()
		return
	}
	useMemoryKeyringForTests()
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
	startPprof()
	// 低优先级启动任务 cleanup-old-logs（delay 1000）
	time.AfterFunc(time.Second, func() { rootLog.CleanOldLogs(7) })
	hostports.Stage("logger-ready")
	// 读登录 shell 的 PATH（不阻塞启动；探测 CLI 的异步路径会等它），读完再记住 npm 全局 bin
	// （自定义 prefix 且 shell 里没配 PATH 时也能找到已装的 CLI；稍后再跑，不和启动抢资源）
	go mergeLoginShellPath()
	// 这里只复制 2.0.4 文件（不碰钥匙串）；密钥迁移在桌面角色窗口出来后后台跑（secretGate）
	if res, err := migrate.RunFiles(userData); err != nil {
		log.Printf("[migrate] warn: %v", err)
	} else if res.Migrated && !res.Skipped { // Skipped：标记已在，res 是上次迁移读回来的结果，不是这次复制的
		log.Printf("[migrate] copied %d files from %s (chatKeys=%d, secrets pending)", res.FilesCopied, res.From, res.ChatKeysExtracted)
	}

	hostports.Stage("migrate-done")
	router := contract.NewRouter()

	var sh shell.Shell
	var providerLinks *providerlink.Service
	bundle := shellhandlers.Install(shellhandlers.Deps{
		UserData: userData,
		Router:   router,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		SystemLangs: hostports.SystemLanguages(),
		// = host.liveWindows（桌面角色与对话窗口；sh 在外壳建好之前为 nil）
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
	// 角色包的远程素材（官方角色的 .riv 不随安装包发）：选了 Rive 才下载，见 characterassets
	assetsRoot := filepath.Join(userData, "character-assets")
	assetsSvc := characterassets.New(characterassets.Options{
		Root: assetsRoot,
		Active: func() *characterassets.ActivePack {
			p := charSvc.Resolved()
			if p == nil {
				return nil
			}
			return &characterassets.ActivePack{ID: p.Manifest.ID, Rive: p.Rive, Remote: p.Remote}
		},
		Publish: func(s characterassets.State) { router.Emit("character.assetsChanged", s) },
		Log:     deps.StdLogger{Prefix: "[character-assets]"},
	})
	charSvc.OnChange(assetsSvc.Refresh)
	if bundle.Settings.Get().Mascot.Renderer == "rive" {
		go assetsSvc.Ensure()
	}
	// 素材库：全部生成的图片（Nomi 的 image_generate、编程助手生成后复制过来的），删除移到废纸篓
	chatAssetsLib := chatassets.New(chatassets.Deps{
		ChatRoot:  filepath.Join(userData, "chat"),
		TrashItem: trash.Item,
		ShowItemInFolder: func(p string) {
			hostPorts{sh: &sh}.ShowItemInFolder(p)
		},
		OnChanged: func() { router.Emit("chatAssets.changed", nil) },
		SaveFile: func(name string) string {
			home, _ := os.UserHomeDir()
			p, _ := hostPorts{sh: &sh}.SaveFile(context.Background(), "", filepath.Join(home, "Downloads", name), nil)
			return p
		},
	})
	mascotCtl := mascothandlers.Install(mascothandlers.Deps{
		ChatAssets: chatAssetsLib,
		Assets:     assetsSvc,
		Persona:    personaSvc,
		T:          func(k string) string { return i18n.T(k) },
		ChatBg:     chatBgSvc,
		Router:     router,
		Config:     bundle.Config,
		Settings:   bundle.Settings,
		Character:  charSvc,
		Island:     isl,
		Geometry: func() shell.Geometry {
			g, _ := sh.(shell.Geometry)
			return g
		},
		Quit:     func() { sh.Quit() },
		OpenChat: func() { sh.Show(shell.Chat) },
		AppName:  "Nomi",
	})
	// 桌面工具 / 工作区（授权、审计、撤销、回收站、提醒、拖入总结）
	home, _ := os.UserHomeDir()
	ports := hostPorts{sh: &sh}
	desktopSvc := desktop.CreateService(userData, desktop.Ports{Home: home, PickDirectory: func(title, button, def string) string {
		dir, _ := ports.PickDir(title, button, def)
		return dir
	}, ClipboardRead: ports.ClipboardRead, ClipboardWrite: ports.ClipboardWrite,
		// 系统通知（mac 开发态不在 .app 里时不可用，桌面服务退回岛 / 气泡）
		NotifySupported: func() bool {
			n, ok := sh.(shellNotifier)
			return ok && n.NotifySupported()
		},
		ShowNotification: func(title, body string, onClick func()) {
			if n, ok := sh.(shellNotifier); ok {
				n.ShowNotification(title, body, onClick)
			}
		}}, router.EmitTo)
	// = Application desktopWindows（桌面角色窗口、对话窗口、临时召回、灵动岛）；外壳建好后才有窗口
	desktopSvc.AttachWindows(desktopWindows(&sh, bundle.Startup, isl))
	desktop.Register(router, desktopSvc)
	desktopSvc.StartReminders()
	// 知识库 / 记忆 / 定时 / 本地模型 / 导出 / 扩展；Desktop 与桌面工具共用同一个 DesktopService。
	// complete()：知识库 / 记忆 / 日程的 AI 补全，延迟绑定 ChatFacade（AI runtime 未就绪 → electron.common.ai-service-not-ready）
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
	// LocalModelService 的 gateway()（没有网关服务时为 null）；网关服务稍后创建，延迟取
	var gatewaySvc *gwstore.Service
	// aiRuntime 的 listProviders / providerCredentials 走网关；知识库与语音共用
	aiGateway := func() mediahandlers.GatewayLike {
		if gatewaySvc == nil {
			return nil
		}
		return gatewaySvc
	}
	// AIClient 门面（client.memory）稍后创建，记忆服务用时再取
	var aiFacade *aifacade.Facade
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
		LegacyReminders: func() []tasks.LegacyReminder {
			out := []tasks.LegacyReminder{}
			if desktopSvc.Reminders == nil {
				return out
			}
			for _, r := range desktopSvc.Reminders.List(false, 0) {
				out = append(out, tasks.LegacyReminder{ID: r.ID, Text: r.Text, DueAt: int64(r.DueAt), Status: r.Status, Repeat: r.Repeat})
			}
			return out
		},
		T:     i18n.T,
		Ports: ports,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		Providers:    kbProviders(aiGateway),
		Credentials:  kbCredentials(aiGateway),
		ChatProvider: kbChatProvider(desktopSvc),
		MemoryFacade: aiMemory(&aiFacade),
		Confirm:      knowledgehandlers.ConfirmAdapter{B: desktopSvc.Broker},
	})
	// 内存 ProviderStore + ProviderService（providers.* 契约过程 + providers.changed）
	providerBox := security.NewSecretBox("providers")
	// GatewayStore：userData/gateway/store.json（格式 / 迁移 / 归档见 gwstore）
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
		// 请求正文追踪目录：跟随诊断日志开关（GatewayRequestLog 晚绑定；没接上时不追踪）
		TraceDir: func() string {
			if l := gatewayRequestsRef.Load(); l != nil {
				return l.TraceDir()
			}
			return ""
		},
	})
	// UsageService（构造 + start；网关 init 后 autoSync）
	defer wireUsage(router, userData, desktopSvc, gatewaySvc)()
	// 2.0.4 密钥迁移屏障。窗口先出（page-loaded mascot），再迁密钥（唯一一次钥匙串授权框），
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
	// ToolRegistry + MCP 桥（AiSdkMcpPlugin / McpBridgePlugin）+ 扩展的 ext.attach
	toolRegistry := tools.NewInMemory()
	// 画像落 userData/ai-chat/memory/user_profile.json；引导期 export() 同 createAiSdkBooter。
	nowMs := func() float64 { return float64(time.Now().UnixMilli()) }
	userProfile := aifacade.NewProfileStore(aifacade.ProfilePath(userData), nowMs)
	userProfile.Export()
	// 非 MCP 的 ig 工具：builtin → preference → companion → kb → mem → delegate → ext；
	// MCP 工具在异步 connect 后才注册，排在这些之后
	// Nomi 生图（对话的 image_generate 与素材库的「重新生成」共用一套依赖）
	imgDeps := imageToolDeps(gatewaySvc, filepath.Join(userData, "chat", "images"), chatAssetsLib)
	chatAssetsLib.SetGenerate(func(req chatassets.GenerateReq) (string, error) {
		r, err := imgDeps.GenerateAsset(context.Background(), igtools.GenerateReq{Prompt: req.Prompt, Aspect: req.Aspect,
			ModelRef: req.ModelRef, EditFrom: req.EditFrom, References: req.References})
		return r.File, err
	})
	registerIgTools(toolRegistry, userProfile, &aiFacade, b8.KB, b8.Mem, b8.Ext, desktopSvc,
		imgDeps, b8.Tasks, b8.Conns)
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
	// desktop.attachRuntime（工具结果接收者 / 摘要补全）+ prepareChat（会话工作区 + 外发检查）
	desktopSvc.AttachRuntime(shellhandlers.DesktopRuntimeHooks(providerSvc, llmRegistry, gatewaySvc,
		func(ctx context.Context, role string, msgs []blm.ChatMessage) (string, error) {
			resp, err := chatFacade.SendMessage(ctx, &facade.ChatStreamOptions{Role: &role, Messages: msgs, Signal: ctx.Done()})
			if err != nil {
				return "", err
			}
			return resp.Content, nil
		}))
	chatHandlers := airouter.New(airouter.Options{Chat: chatFacade, Logger: deps.StdLogger{Prefix: "[ai-runtime]"},
		PrepareChat: func(options map[string]any, method string, signal <-chan struct{}) error {
			// 上下文预算：按路由到的模型的窗口算（gwstore nomicontext），不再用固定的 8K
			if gatewaySvc != nil {
				gwstore.ApplyNomiContext(options, method, gatewaySvc.NomiContext)
			}
			prep := desktopSvc.ChatPrep()
			// 用户对话（带工具的一轮）：追加「现在做还是派出去」的判断规则（docs/features/scheduling-calendar.md）
			prep.AfterWorkspace = func(options map[string]any, method string) error {
				if method == "agentStream" && options["role"] == "chat" && b8.Tasks != nil {
					_, err := delegate.ApplyDispatchHint(options)
					return err
				}
				return nil
			}
			return prep.PrepareChat(options, method, signal)
		}})
	chatHandlers.Register(router)
	defer chatHandlers.Dispose()
	// AIClient 门面：ai.sessions / tools / memory / asr / tts / avatar（32 个过程）。
	aiFacade = aifacade.New(aifacade.Options{Now: nowMs, Tools: toolRegistry, Profile: userProfile, Avatar: true,
		AvatarHost: func(cue *util.Obj) { router.Emit("avatar.event", cue) }, Emit: router.Emit})
	aiFacade.Register(router)
	// 持续任务的 Nomi 无界面执行（docs/features/scheduling-calendar.md）：工具白名单 + 不冒气泡；审批走 broker 的后台模式
	b8.Tasks.RegisterExecutor("nomi", tasks.NewNomiExecutor(tasks.NomiDeps{
		AgentStream: func(ctx context.Context, msgs []blm.ChatMessage, toolNames []string, extra map[string]any, emit func(blm.ChatChunk)) error {
			role := "agent-tools"
			return chatFacade.AgentStream(ctx, &facade.ChatStreamOptions{Role: &role, Messages: msgs, Signal: ctx.Done(),
				Tools: toolNames, Quiet: true, Extra: extra}, emit)
		},
		WithBackground: func(ctx context.Context, level int, ask func(tool, summary, detail string) bool, conns []tasks.ConnectionGrant, tainted, trusted bool, external connections.ExternalJournal) context.Context {
			run := &desktop.BackgroundRun{Level: level, Ask: ask, Tainted: tainted, Trusted: trusted, External: external}
			for _, g := range conns {
				run.Connections = append(run.Connections, desktop.ConnGrant{ConnectionID: g.ConnectionID, Capabilities: g.Capabilities, Resources: g.Resources})
			}
			return desktop.WithBackground(ctx, run)
		},
		LiveTask: func(id string) *tasks.Task {
			if rec := b8.Tasks.Runtime.Get(id); rec != nil {
				t := rec.Task
				return &t
			}
			return nil
		},
		LiveGrant: func(ctx context.Context, live func() (tasks.Grant, bool), trusted bool, extra func([]tasks.ConnectionGrant) []tasks.ConnectionGrant) {
			run := desktop.BackgroundFrom(ctx)
			if run == nil {
				return
			}
			run.Live = func() (desktop.LiveGrant, bool) {
				g, ok := live()
				if !ok {
					return desktop.LiveGrant{}, false
				}
				cs := g.Connections
				if extra != nil {
					cs = extra(cs)
				}
				out := desktop.LiveGrant{Level: g.Level, Paths: g.Paths}
				for _, c := range cs {
					out.Connections = append(out.Connections, desktop.ConnGrant{ConnectionID: c.ConnectionID, Capabilities: c.Capabilities, Resources: c.Resources})
				}
				return out, true
			}
		},
		Ready: func() bool {
			_, _, ok := airouter.Routed{R: llmRegistry}.Resolve("agent-tools")
			return ok
		},
		Route: func() (string, string) {
			pid, model := "", ""
			if p := desktopSvc.ProviderFor("agent-tools"); p != nil {
				pid = p.ID
			}
			if _, m, ok := (airouter.Routed{R: llmRegistry}).Resolve("agent-tools"); ok && m != nil {
				model = *m
			}
			return pid, model
		},
		CostOf: func(model string, in, out int64) (float64, bool) {
			s := usageSvcRef.Load()
			if s == nil {
				return 0, false
			}
			return s.CostOf(model, util.NewObj("input", float64(in), "output", float64(out)))
		},
		Trace: func(taskID, attemptID string, line map[string]any) {
			if err := b8.Tasks.Store.AppendTrace(taskID, attemptID, line); err != nil {
				log.Printf("[tasks] trace: %v", err)
			}
		},
		EventsFor:       b8.Tasks.EventBatch,
		ExternalJournal: b8.Tasks.ExternalJournal,
		// 派给 Nomi 的执行用对话的工具集
		ToolNames: func() []string {
			defs := toolRegistry.List()
			names := make([]string, 0, len(defs))
			for _, d := range defs {
				names = append(names, d.Name)
			}
			return names
		},
	}))
	// 持续任务的编程助手执行（docs/features/scheduling-calendar.md）：后台标签，默认直接在代码目录里改
	// （别的分支做基线时用 worktree，验收时落地）；同一种任务复用会话；审批走任务收件箱
	b8Tasks = b8.Tasks
	taskCli := taskCliDeps(desktopSvc)
	taskCli.EventsFor = b8.Tasks.EventBatch
	b8.Tasks.RegisterExecutor("cli", tasks.NewCliExecutor(taskCli))
	// 事件源：web / folder / github / app；编程助手的 tab-finished 在 wireHarness 之后接上
	registerTaskSources(b8)
	b8.ApplyWorktree = taskApplyWorktree(desktopSvc)
	// AI 运行时与门面就绪后再启动（记忆启动时把事实与摘要同步给门面）
	b8.Start()
	defer b8.Stop()
	shellhandlers.InstallGateway(router, gatewaySvc)
	// 第三方供应商链接 nomi://provider/*（docs/integrations/provider-link.md）：宿主经 OnURL 转来，确认框在对话窗口
	providerLinks = providerlink.New(providerlink.Deps{
		Gateway: func() providerlink.Gateway {
			if gatewaySvc == nil {
				return nil
			}
			return gatewaySvc
		},
		OpenExternal: ports.OpenExternal,
		Publish:      func(o []providerlink.Offer) { router.Emit("providerLink.changed", o) },
		Reveal: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		// 与网关连上游同一套规则：拒绝本机 / 局域网，代理软件的 fake-ip（198.18/15）对域名放行
		AssertPublic: func(u string) error {
			if _, _, err := gwnet.ResolveUpstreamAddresses(context.Background(), u, gwnet.GuardOpts{}); err != nil {
				var blocked *gwnet.UpstreamBlockedError
				if errors.As(err, &blocked) {
					return &providerlink.Error{Code: "private_host"}
				}
				return &providerlink.Error{Code: "network"}
			}
			return nil
		},
		Logger: deps.StdLogger{Prefix: "[provider-link]"},
	})
	shellhandlers.InstallProviderLink(router, providerLinks)
	shellhandlers.InstallTerminal(router, shellhandlers.NewGatewayTerminal(userData, gatewaySvc, deps.StdLogger{Prefix: "[gateway]"}))
	// 语音输入（voice.*）/ 朗读（tts.*）/ nav.openVoiceSettings
	mediahandlers.Wire(mediahandlers.WireDeps{
		Providers:   mediahandlers.GatewayProviders(aiGateway),
		Credentials: mediahandlers.GatewayCredentials(aiGateway),
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
	gatewayRequestsRef.Store(gatewayRequests)
	defer gatewayRequests.Dispose()
	cliPlugins, disposeHarness := wireHarness(router, userData, home, ports, gatewaySvc, shellP.Quality)
	wireNomiBroker(desktopSvc.Broker, harnessOrch)
	taskCliFinished.attach(harnessOrch)
	// 委派 / 任务直接改同一仓库：按文件、按优先级裁决；启动时清理没人认领的委派 worktree
	wireDelegateClaims(harnessOrch)
	go func() {
		sweepDelegateWorktrees(harnessOrch, b8.Tasks)
		closeStaleDelegatedTabs(harnessOrch)
	}()
	// 命令自动审核：交给 Nomi 的辅助模型（摘要角色，没设时跟主模型）判风险。没配模型、或这个模型在云端
	// 且用户还没同意过发送（不为审核额外弹窗）时不审，照旧交给人确认
	desktopSvc.Broker.AIReview = func() bool { return jsrt.Call(harnessOrch.AiReviewEnabled) }
	desktopSvc.Broker.Reviewer = func(ctx context.Context, in desktop.CommandReviewInput) *desktop.CommandReview {
		if !desktopSvc.Broker.CanSendQuietly(desktopSvc.ProviderFor("summary")) {
			return nil
		}
		return desktop.ReviewCommand(ctx, in, func(c context.Context, msgs []map[string]string) (string, error) {
			chatFacade := chatFacadeRef.Load()
			if chatFacade == nil {
				return "", errors.New(i18n.T("electron.common.ai-service-not-ready"))
			}
			role := "summary"
			cm := make([]blm.ChatMessage, 0, len(msgs))
			for _, m := range msgs {
				cm = append(cm, blm.ChatMessage{Role: m["role"], Content: m["content"]})
			}
			resp, err := chatFacade.SendMessage(c, &facade.ChatStreamOptions{Role: &role, Messages: cm, Signal: c.Done()})
			if err != nil {
				return "", err
			}
			return resp.Content, nil
		}, 0)
	}
	desktopSvc.Broker.OnReviewed = func(tool string, r *desktop.CommandReview) {
		log.Printf("[desktop] command reviewed tool=%s risk=%s authorization=%s outcome=%s", tool, r.Risk, r.Authorization, r.Outcome)
	}
	wireCoding(router, userData, cliPlugins, desktopSvc, gatewaySvc, toolRegistry, b8.Tasks)
	defer wireAgents(router, userData, desktopSvc)()
	wireScreenAndPending(router, userData, rootLog, desktopSvc)
	defer disposeHarness()
	log.Printf("[desktop-go] %d contract procedures stubbed (not implemented yet)", procs.Install(router))

	ctl := os.Getenv("NOMI_POC_CTL")
	ws := &contract.WSServer{Router: router, Origins: map[string]bool{
		"wails://localhost": true, "wails://wails": true, "http://wails.localhost": true, "wails://wails.localhost": true,
	}}
	// 截图脚本 / CI：视图也在回环 HTTP 上提供，内核接受这个来源（webviews.go，只在设置了 NOMI_POC_CTL 时生效）
	web := listenWebViews(ctl)
	if web != nil {
		ws.Origins[web.origin] = true
	}
	if err := ws.Start(); err != nil {
		log.Fatal(err)
	}

	assets, _ := fs.Sub(dist, "frontend/dist")
	// 每个窗口（每次新建 / 重建）一份 token，绑定窗口的界面：内核按 token 认调用方，不信页面自报的界面；
	// 窗口关闭时撤销。灵动岛页不连内核，不发 token
	frag := func(k shell.WindowKind) (url.Values, func()) {
		v := url.Values{}
		if ctl != "" {
			v.Set("ctl", ctl)
		}
		var surface string
		switch k {
		case shell.Mascot:
			surface = "mascot"
		case shell.Chat:
			surface = "chat"
		default:
			return v, nil
		}
		token, revoke := ws.Issue(surface)
		v.Set("ws", ws.URL)
		v.Set("token", token)
		return v, revoke
	}
	// 窗口生命周期：桌面角色控制器；用户关掉桌面角色窗口 = 退出（requestQuit）；
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
	// 拖进对话窗口的文件：macOS / Linux 上网页拿不到 File，宿主发一次性临时地址（hostdrop）
	drops := hostdrop.New()
	// 视图资源的中间件链：应用窗口与（截图 / CI 用的）回环 HTTP 共用
	viewsMW := devViewsMiddleware(viewPageMiddleware(assets, drops.Middleware(islandPageMiddleware(isl, builtinPackMiddleware(charSvc, assetproto.Middleware(map[string]func(http.ResponseWriter, string){
		// registerChatAssetProtocol：用户图片在 userData/chat，预设在应用资源
		assetproto.ChatAssetScheme: func(w http.ResponseWriter, u string) {
			assetproto.ServeChatAsset(w, filepath.Join(userData, "chat"), chatBgPresetFile(), u)
		},
		// registerCharacterPackProtocol(protocol, () => this.resolved.root)
		assetproto.CharacterPackScheme: func(w http.ResponseWriter, u string) {
			assetproto.ServeCharacterPackOrAssets(w, charSvc.Root(), assetsRoot, u)
		},
	}))))))
	sh = wailsshell.New(wailsshell.Config{Assets: assets, Fragment: frag, Pages: pages, MascotSize: mascotCtl.WindowSize, MascotPos: mascotCtl.WindowPosition, OnWindow: onWindow,
		// 托盘菜单
		TrayMenu: func() []shell.MenuItem {
			return tray.Menu(tray.Deps{
				T: i18n.T, TName: i18n.TName,
				State: func() any { return gatewaySvc.State() },
				Select: func(ref string) {
					if err := gatewaySvc.SetAssignment("nomi", util.NewObj("models", util.NewObj("main", ref))); err != nil {
						log.Printf("[tray] switch model failed: %v", err)
					}
				},
				Locked: func() bool {
					id, _ := providerSvc.State().Get("overrideId").(string)
					return id != ""
				},
				CharacterName: func() string {
					p := personaSvc.Get()
					if p.ShortName != "" {
						return p.ShortName
					}
					return p.DisplayName
				},
				OpenChat:          func() { sh.Show(shell.Chat) },
				OpenProviderPanel: func() { shellhandlers.OpenProviderPanel(router, func() { sh.Show(shell.Chat) }, "") },
				OpenDesktopPanel: func() {
					shellhandlers.OpenProviderPanel(router, func() { sh.Show(shell.Chat) }, "nav.desktopPanelRequested")
				},
				Gesture: func(name string) { deps.AvatarGesture(hostEvents{router}, name) },
				// = sendMascotCommand({ type: 'open-panel', panel: 'interaction' })
				OpenInteraction: func() {
					router.Emit("mascot.command", map[string]any{"type": "open-panel", "panel": "interaction"})
				},
				Quit: quit,
			})
		},
		// = onActivate: raiseMainOnReactivate（默认界面是主界面时打开主界面）
		OnTrayActivate: func() {
			if bundle.Startup.Get().DefaultView == "main" {
				sh.Show(shell.Chat)
			}
		},
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
		// = app 'activate' / 'second-instance'：桌面角色没关但窗口不在就重建；默认界面是主界面时把主界面带到前台
		// （shouldRaiseMainOnReactivate），否则聚焦已有窗口
		OnReactivate: func() {
			st := bundle.Startup.Get()
			if st.ShowMascot && !sh.Visible(shell.Mascot) {
				sh.Show(shell.Mascot)
			}
			switch {
			case st.DefaultView == "main" || !st.ShowMascot:
				sh.Show(shell.Chat)
			case sh.Visible(shell.Chat):
				sh.Show(shell.Chat)
			default:
				sh.Show(shell.Mascot)
			}
		},
		// = ThemeService 订阅 appearance.onChange
		OnSystemThemeChanged: bundle.Theme.SystemChanged,
		// nomi:// 链接（open-url / argv）：交给第三方供应商链接服务（不是 provider 的它会忽略）
		OnURL: func(u string) {
			if providerLinks != nil {
				providerLinks.Receive(u)
			}
		},
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
			case "nomi:clipboard-files":
				// 对话页粘贴了文件：WebKit 不给路径，从系统剪贴板读（访达 / 资源管理器里复制的文件）
				if c, ok := sh.(interface{ ClipboardFilePaths() []string }); ok {
					if paths := c.ClipboardFilePaths(); len(paths) > 0 {
						sendHostFiles(sh, paths)
					}
				}
			case "nomi:island:hidden":
				isl.Hidden()
			case "nomi:island:open":
				isl.Opened()
			}
		},
		OnFilesDropped: func(k shell.WindowKind, paths []string) {
			switch k {
			case shell.Mascot:
				// 拖到桌面角色：只认桌面角色窗口，只取第一个文件
				desktopSvc.DropFile("mascot", paths[0])
			case shell.Chat:
				// 路径交给对话页按文件名配对（ai-chat services/api.ts 的 nomi:host-files）；
				// 带上一次性临时地址，网页没收到 DOM drop 时（macOS / Linux）据此读出文件
				sendHostFiles(sh, drops.Add(paths))
			}
		},
		IslandLayout: func() (shell.Rect, string, bool) {
			g, ok := isl.Layout()
			if !ok {
				return shell.Rect{}, "", false
			}
			r := island.IslandWindowRect(g, g.Height)
			return shell.Rect{X: int(r.X), Y: int(r.Y), Width: int(r.Width), Height: int(r.Height)}, islandPagePath, true
		},
		Middleware: viewsMW,
	})
	if web != nil {
		web.serve(viewsMW(http.FileServer(http.FS(assets))))
	}

	shellP.AttachShell()
	// = ThemeService.syncAppearance（mac：外观跟随固定主题）
	if a, ok := sh.(interface{ SetAppearance(string) }); ok {
		bundle.Theme.SetAppearanceHook(a.SetAppearance)
	}
	// 托盘菜单随模型（网关 / 供应商锁定）、界面语言、角色变化重建
	if rt, ok := sh.(interface{ RebuildTray() }); ok {
		gatewaySvc.OnChange(rt.RebuildTray)
		providerSvc.OnChange(rt.RebuildTray)
		bundle.OnLocaleChange = append(bundle.OnLocaleChange, rt.RebuildTray)
		personaSvc.OnChange(func(persona.Persona) { rt.RebuildTray() })
	}
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
			case "web-url": // 截图 / CI：给浏览器一个带本次 token 的页面地址（需 NOMI_WEB_VIEWS）
				u, err := web.pageURL(ws, r.URL.Query().Get("surface"), ctl)
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				w.Write([]byte(u + "\n"))
				return
			case "quit":
				sh.Quit()
			}
			w.Write([]byte("ok\n"))
		}))
	}

	// 启动偏好：桌面角色按 showMascot 显示；关掉桌面角色时保证主界面可达（#55）
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
	// 启动后默认界面（planStartup）：首次引导等桌面角色先出来再打开（ONBOARDING_OPEN_DELAY_MS）；defaultView=main 直接打开；
	// 桌面角色关着或没有托盘时也打开主界面，避免无界面。测量模式（NOMI_POC_CTL）不自动开，对话由 show-chat 显式打开
	if ctl == "" {
		switch {
		case bundle.Onboarding.ShouldAutoOpen():
			time.AfterFunc(1500*time.Millisecond, func() { sh.Show(shell.Chat) })
		case bundle.Startup.Get().DefaultView == "main", !showMascot, !sh.TrayAvailable():
			sh.Show(shell.Chat)
		}
	}
	// 桌面角色窗口的鼠标进出（mousetrack）
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

// islandPagePath：Wails 窗口只能加载资产服务器上的页面，
// 这里按当前几何现场生成同一份 HTML（页面自带 meta CSP）
const islandPagePath = "/__island.html"

// viewPageMiddleware：视图页面按 Go 宿主改写 CSP、插入 Wails 运行时（viewpage）
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

// 视图里内置角色包的地址：renderer 的 ./character/…（整包）、ai-chat 的 ./character/onboarding/…（引导插画，
// 对应包内 assets.onboardingDir）。frontend/build.mjs 不把它们嵌进程序，这里从内核读的同一份内置包目录提供
const (
	mascotPackPrefix     = "/mascot/character/"
	chatOnboardingPrefix = "/chat/character/onboarding/"
)

func builtinPackMiddleware(charSvc *character.Service, next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler {
		inner := next(h)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.EscapedPath()
			rel, onboarding := strings.CutPrefix(p, chatOnboardingPrefix)
			if !onboarding {
				var ok bool
				if rel, ok = strings.CutPrefix(p, mascotPackPrefix); !ok {
					inner.ServeHTTP(w, r)
					return
				}
			}
			pack := charSvc.Builtin()
			if pack == nil {
				assetproto.ServeBuiltinPack(w, r, "", rel) // 404
				return
			}
			if onboarding {
				rel = pack.OnboardingDir + "/" + rel
			}
			assetproto.ServeBuiltinPack(w, r, pack.Root, rel)
		})
	}
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

// 读 / 写密钥（网关 store、供应商 token、语音 key、AI 聊天）的契约过程：2.0.4 密钥迁移完成前先等
var secretGatedPrefixes = []string{"gateway.", "providers.", "ai.", "voice.", "tts.", "usage.", "harness.", "cli.", "cliAccount.", "delegate.", "local."}

// firstWindowShown：任一窗口页面加载完（桌面角色被设置隐藏时是主窗口）就关闭
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

// islandBridge：灵动岛页面收起时设 document.title = 'hidden:…'、点击时设 location.hash =
// '#open-…'；Wails 没有页面标题 / 页内导航事件，这里转成消息。
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

// desktopWindows = Application 的 desktopWindows：main = 桌面角色窗口；mascotHidden = startup.showMascot 关闭；
// summon / release = 桌面角色关着时临时建出窗口（桌面工具确认框需要宿主），用完仍是关闭状态就再释放
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
		// 工作台（对话窗口）在屏幕上（可见、没最小化）：确认请求只发给它
		ChatOpen: func() bool {
			if sh() == nil {
				return false
			}
			if g, ok := sh().(interface {
				Shown(shell.WindowKind) (bool, bool)
			}); ok {
				v, min := g.Shown(shell.Chat)
				return v && !min
			}
			return sh().Visible(shell.Chat)
		},
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

// sendHostFiles：本机文件路径交给对话页（ai-chat services/api.ts 的 nomi:host-files，按文件名配对）
// sendHostFiles：detail 是路径数组（粘贴）或 hostdrop.Entry 数组（拖放）
func sendHostFiles[T string | hostdrop.Entry](sh shell.Shell, paths []T) {
	if x, ok := sh.(interface {
		ExecJS(shell.WindowKind, string)
	}); ok {
		b, _ := json.Marshal(paths)
		x.ExecJS(shell.Chat, "window.dispatchEvent(new CustomEvent('nomi:host-files',{detail:"+string(b)+"}))")
	}
}
