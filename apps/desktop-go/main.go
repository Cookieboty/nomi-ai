// Nomi Go + Wails v3 架构 POC（docs/design/arch-go-wails.md）。
//
//	NOMI_LLM_BASE_URL / NOMI_LLM_API_KEY / NOMI_LLM_MODEL：OpenAI 兼容接口；没有 key 时起本地 mock。
//	NOMI_POC_CTL=127.0.0.1:PORT：测量用的控制口（/ctl?op=show-chat|close-chat|hide-mascot|show-mascot|renderer&v=svg|rive|quit）。
//	NOMI_USER_DATA / NOMI_APP_DATA：覆盖 userData / appData 根（测试与迁移用）。
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
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/airouter"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk/mcpbridge"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/sdk/facade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/assetproto"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/deps"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/parse"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/extensions"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/local"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/services"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/character"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/chatbg"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/island"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/knowledgehandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mascothandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mediahandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/migrate"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/procs"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/wailsshell"
)

//go:embed all:frontend/dist
var dist embed.FS

func main() {
	// 文档解析子进程（runParse.ts 的 utilityProcess）：同一可执行文件以 NOMI_PARSE_WORKER=1 拉起
	if parse.IsWorker() {
		parse.WorkerMain()
		return
	}
	if exe, err := os.Executable(); err == nil {
		parse.EnableWorker(exe)
	}
	cfg := core.LLMConfig{BaseURL: os.Getenv("NOMI_LLM_BASE_URL"), APIKey: os.Getenv("NOMI_LLM_API_KEY"), Model: os.Getenv("NOMI_LLM_MODEL")}
	if cfg.APIKey == "" {
		base, err := mockllm.Start()
		if err != nil {
			log.Fatal(err)
		}
		cfg = core.LLMConfig{BaseURL: base, APIKey: "mock", Model: "mock"}
		log.Printf("[poc] no API key, using mock LLM at %s", base)
	}
	if cfg.Model == "" {
		cfg.Model = "gpt-4o-mini"
	}

	paths := hostports.Paths{UserDataDir: os.Getenv("NOMI_USER_DATA")}
	userData := paths.UserData()
	if err := os.MkdirAll(userData, 0o700); err != nil {
		log.Fatal(err)
	}
	// LoggerService：最先创建（日志目录 = paths.logs() = userData/logs），各服务共用（deps.Root）
	rootLog := services.NewLogger(services.LoggerOptions{LogDir: filepath.Join(userData, "logs"), Packaged: hostports.IsPackaged})
	deps.Root = rootLog
	defer rootLog.FlushSync()
	if os.Getenv("NODE_ENV") == "development" {
		rootLog.SetLevel(services.DEBUG)
	}
	// 低优先级启动任务 cleanup-old-logs（delay 1000）
	time.AfterFunc(time.Second, func() { rootLog.CleanOldLogs(7) })
	if res, err := migrate.Run(userData, security.NewSecretBox("migrate"), security.NewElectronSafeStorage()); err != nil {
		log.Printf("[migrate] warn: %v", err)
	} else if res.Migrated {
		log.Printf("[migrate] copied %d files from %s (secrets=%d chatKeys=%d)", res.FilesCopied, res.From, res.SecretsMigrated, res.ChatKeysExtracted)
	}

	router := contract.NewRouter()
	core.New(cfg).Register(router)

	var sh shell.Shell
	bundle := shellhandlers.Install(shellhandlers.Deps{
		UserData: userData,
		Router:   router,
		OpenChat: func() {
			if sh != nil {
				sh.Show(shell.Chat)
			}
		},
		SystemLangs: systemLangs(),
		IsDark:      func() bool { return false },
	})
	isl := island.New(filepath.Join(userData, "island.json"), mascothandlers.Platform())
	isl.Notify = func(kind, title, body string, durationMs int, force bool) bool {
		if sh == nil {
			return false
		}
		fresh := !sh.Visible(shell.Island)
		sh.Show(shell.Island)
		// = pump(): __island.prepare + play（show 两步合一）；新建的窗口给页面留装载时间
		if ex, ok := sh.(interface {
			ExecJS(shell.WindowKind, string)
		}); ok {
			n, _ := json.Marshal(map[string]any{"kind": kind, "title": title, "body": body, "durationMs": durationMs})
			js := "window.__island && window.__island.show(" + string(n) + ")"
			if fresh {
				time.AfterFunc(400*time.Millisecond, func() { ex.ExecJS(shell.Island, js) })
			} else {
				ex.ExecJS(shell.Island, js)
			}
		}
		return true
	}
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
	}}, router.EmitTo)
	desktopSvc.AttachWindows(&desktop.Windows{Main: func() bool { return sh != nil }})
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
	})
	if err := gatewaySvc.Init(); err != nil {
		log.Printf("[gateway] store init failed: %v", err)
	}
	gatewaySvc.Start()
	defer gatewaySvc.Dispose()
	providerSvc, llmRegistry := shellhandlers.NewProviderRuntime(providerBox, processEnv(), nil, func(role string) *aiproviders.GatewayResolution {
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
	// ChatFacade + AiContractRouter 的 ai.chat.*（覆盖 core.Core 的演示 ai.chat.stream）
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
	shellhandlers.InstallGateway(router, gatewaySvc)
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
	cliPlugins, disposeHarness := wireHarness(router, userData, home, ports)
	wireCoding(router, userData, cliPlugins, desktopSvc)
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
	sh = wailsshell.New(wailsshell.Config{Assets: assets, Fragment: frag, MascotSize: mascotCtl.WindowSize, OnWindow: mascotCtl.WindowEvent,
		IslandLayout: func() (shell.Rect, string, bool) {
			g, ok := isl.Layout()
			if !ok {
				return shell.Rect{}, "", false
			}
			r := island.IslandWindowRect(g, g.Height)
			return shell.Rect{X: int(r.X), Y: int(r.Y), Width: int(r.Width), Height: int(r.Height)}, islandPagePath, true
		},
		Middleware: islandPageMiddleware(isl, assetproto.Middleware(map[string]func(http.ResponseWriter, string){
			// registerChatAssetProtocol：用户图片在 userData/chat，预设在应用资源
			assetproto.ChatAssetScheme: func(w http.ResponseWriter, u string) {
				assetproto.ServeChatAsset(w, filepath.Join(userData, "chat"), chatBgPresetFile(), u)
			},
			// registerCharacterPackProtocol(protocol, () => this.resolved.root)
			assetproto.CharacterPackScheme: func(w http.ResponseWriter, u string) {
				assetproto.ServeCharacterPack(w, charSvc.Root(), u)
			},
		}))})

	shellP.AttachShell()

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

	sh.Show(shell.Mascot)
	// 没有托盘时自动开对话窗口兜底；测量模式（NOMI_POC_CTL）不开，与 POC 口径一致（对话由 show-chat 显式打开）
	if !sh.TrayAvailable() && ctl == "" {
		sh.Show(shell.Chat)
	}
	if err := sh.Run(); err != nil {
		log.Fatal(err)
	}
}

func systemLangs() []string {
	for _, k := range []string{"LANG", "LC_ALL", "LC_MESSAGES"} {
		if v := os.Getenv(k); v != "" {
			return []string{strings.Split(v, ".")[0]}
		}
	}
	return []string{"zh-CN"}
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
			_, _ = w.Write([]byte(island.IslandHTML(g)))
		})
	}
}

// mcpLogger：mcpbridge.Logger（ConsoleRuntimeLogger 的 [mcp] 前缀）
type mcpLogger struct{}

func (mcpLogger) Info(m string, kv ...any)  { log.Println(append([]any{"[mcp]", m}, kv...)...) }
func (mcpLogger) Warn(m string, kv ...any)  { log.Println(append([]any{"[mcp] WARN", m}, kv...)...) }
func (mcpLogger) Error(m string, kv ...any) { log.Println(append([]any{"[mcp] ERROR", m}, kv...)...) }
