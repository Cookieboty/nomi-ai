// Package wailsshell：Shell 的 Wails v3 实现。只做窗口、托盘、系统集成；不含业务。
package wailsshell

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
)

// AppID 与 Electron appId 一致（electron-builder.yml），单实例锁 / 打包元数据共用
const AppID = "com.cookieboty.nomi"

type Config struct {
	Assets fs.FS
	// Fragment 附在页面地址后（WS 地址与 token，片段不发给服务器）
	Fragment url.Values
	// Pages：各窗口的页面路径（资产服务器上，如 /mascot/index.html）
	Pages map[shell.WindowKind]string
	// OnFilesDropped：从系统拖到看板娘 / 对话窗口（data-file-drop-target 元素）上的文件路径
	// （= preload nomiHost.dropFile / pathForFile）
	OnFilesDropped func(k shell.WindowKind, paths []string)
	// MascotSize 返回看板娘窗口初始大小（按保存的缩放，夹到主屏工作区 = maxScaleForArea）；nil 时用 330×355
	MascotSize func(work *shell.Rect) (int, int)
	// MascotPos 返回保存的看板娘窗口位置（config.windowPosition）；无效时按 2.0.4 放到主屏工作区右下角
	MascotPos func() (int, int)
	// ChatBounds：对话窗口这次打开用的位置大小（= restoreChatBounds，workAreas[0] 是主屏）；nil 时居中默认尺寸
	ChatBounds func(workAreas []shell.Rect) shell.SavedChatBounds
	// SaveChatBounds：对话窗口移动 / 缩放（防抖）与关闭时记下非最大化时的位置大小（config.chatWindowBounds）
	SaveChatBounds func(b shell.SavedChatBounds)
	// OnWindow：窗口生命周期（"created" 新建或重建完成且原生窗口已就位 / "closed" 当前窗口关闭 /
	// "user-closed" 用户关掉了当前窗口（紧跟 closed） / "shown" show·restore / "moved" 窗口移动过）
	OnWindow func(k shell.WindowKind, event string)
	// OnSystemThemeChanged：系统外观（深浅色）变化（= nativeTheme 'updated'）
	OnSystemThemeChanged func()
	// OnPageMessage：页面经 Wails 消息通道发来的 nomi:* 信号（first-paint 与开发态日志除外）
	OnPageMessage func(msg string)
	// Middleware 挂在资产服务器上（chat-asset:// / character-pack:// 网关，见 assetproto）
	Middleware func(http.Handler) http.Handler
	// IslandLayout：灵动岛窗口矩形（islandWindowRect(g, g.height)，屏幕绝对坐标）与页面地址；nil/false 用占位页
	IslandLayout func() (rect shell.Rect, page string, ok bool)
	// OpenProviderPanel：托盘「模型设置」（= TrayManager openProviderPanel）；nil 时不显示该项
	OpenProviderPanel func()
	// ModelSettingsLabel：该项文案（t('electron.common.model-settings')）
	ModelSettingsLabel string
}

type Wails struct {
	app  *application.App
	cfg  Config
	mu   sync.Mutex
	wins map[shell.WindowKind]*application.WebviewWindow
	tray *application.SystemTray
	aot  map[shell.WindowKind]bool // SetAlwaysOnTop 记下的状态（重建时沿用）
	// 应用图标（appicon.go）：新建窗口回调、启动前排队的操作
	created []func(IconWindow)
	started bool
	pending []func()
	// loads：窗口页面还在加载（= webContents.isLoading()）时，等 did-finish-load 的回调
	loads map[*application.WebviewWindow]*pageLoad
	// notes：系统通知（notify.go）
	notes *notifier
}

type pageLoad struct {
	done bool
	fns  []func()
}

func New(cfg Config) *Wails {
	w := &Wails{cfg: cfg, wins: map[shell.WindowKind]*application.WebviewWindow{}, aot: map[shell.WindowKind]bool{}, loads: map[*application.WebviewWindow]*pageLoad{},
		notes: newNotifier()}
	w.app = application.New(application.Options{
		Name:     "Nomi",
		Services: w.notes.services(),
		// Bundled：额外提供 /wails/runtime.js（完整运行时：--wails-draggable 拖动窗口、文件拖放；viewpage 插进页面）
		Assets: application.AssetOptions{Handler: application.BundledAssetFileServer(cfg.Assets), Middleware: cfg.Middleware},
		// 页面首帧（renderer 入口 index.tsx 发 nomi:first-paint）：mac 上 Wails 要等 DidFinishNavigation
		// 才 Show，这里按 Electron ready-to-show 的语义在首帧就显示（§3.4 D-B11-17）
		RawMessageHandler: func(win application.Window, msg string, _ *application.OriginInfo) {
			// 开发态（devviews → viewpage）页面转来的 console 与报错
			if rest, ok := strings.CutPrefix(msg, viewpage.LogPrefix); ok && win != nil {
				log.Printf("[view %s] %s", win.Name(), rest)
				return
			}
			// 页面发给宿主的信号（如灵动岛的 nomi:island:hidden / open，见 main.go islandPageMiddleware）
			if strings.HasPrefix(msg, "nomi:") && msg != "nomi:first-paint" {
				if cfg.OnPageMessage != nil {
					go cfg.OnPageMessage(msg)
				}
				return
			}
			if msg != "nomi:first-paint" || win == nil {
				return
			}
			hostports.Stage("first-paint " + win.Name())
			if goruntime.GOOS == "darwin" {
				application.InvokeAsync(func() { win.Show() })
			}
		},
		Mac:     application.MacOptions{ActivationPolicy: application.ActivationPolicyAccessory, ApplicationShouldTerminateAfterLastWindowClosed: false},
		Linux:   application.LinuxOptions{DisableQuitOnLastWindowClosed: true, ProgramName: "nomi"},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true},
		// = Electron requestSingleInstanceLock + second-instance：第二次启动（含 nomi:// deep link，
		// Win/Linux 经 argv 传入）只把已有实例的对话窗带到前台；deep link 白名单为空，与 Electron 相同不执行动作
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: AppID,
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				w.Show(shell.Chat)
			},
		},
	})
	w.hookStarted()
	if cfg.OnSystemThemeChanged != nil {
		w.app.Event.OnApplicationEvent(events.Common.ThemeChanged, func(*application.ApplicationEvent) {
			go cfg.OnSystemThemeChanged()
		})
	}
	if trayHostAvailable() {
		w.setupTray()
	} else {
		log.Printf("[shell] no system tray host (StatusNotifierWatcher); running tray-less")
	}
	return w
}

func (w *Wails) setupTray() {
	t := w.app.SystemTray.New()
	setTrayIcon(t)
	t.SetLabel("Nomi")
	m := w.app.NewMenu()
	m.Add("显示 / 隐藏看板娘").OnClick(func(*application.Context) { w.toggle(shell.Mascot) })
	m.Add("打开 / 关闭对话").OnClick(func(*application.Context) { w.toggle(shell.Chat) })
	m.Add("显示通知条").OnClick(func(*application.Context) { w.toggle(shell.Island) })
	if w.cfg.OpenProviderPanel != nil {
		m.AddSeparator()
		m.Add(w.cfg.ModelSettingsLabel).OnClick(func(*application.Context) { go w.cfg.OpenProviderPanel() })
	}
	m.AddSeparator()
	m.Add("退出").OnClick(func(*application.Context) { w.Quit() })
	t.SetMenu(m)
	w.tray = t
}

func (w *Wails) TrayAvailable() bool { return w.tray != nil }

func (w *Wails) toggle(k shell.WindowKind) {
	if w.Visible(k) {
		w.Destroy(k)
	} else {
		w.Show(k)
	}
}

func (w *Wails) page(k shell.WindowKind) string {
	return w.cfg.Pages[k] + "#" + w.cfg.Fragment.Encode()
}

func (w *Wails) Show(k shell.WindowKind) {
	w.mu.Lock()
	win := w.wins[k]
	w.mu.Unlock()
	if win != nil {
		win.Show()
		return
	}
	w.create(k, nil)
}

// ShowOnceLoaded = 打开窗口后 `if (webContents.isLoading()) webContents.once('did-finish-load', fn)`：
// 页面还在加载时返回登记函数（fn 在加载完成后异步调用一次），已加载完返回 nil
func (w *Wails) ShowOnceLoaded(k shell.WindowKind) func(fn func()) {
	w.Show(k)
	w.mu.Lock()
	defer w.mu.Unlock()
	win := w.wins[k]
	pl := w.loads[win]
	if win == nil || pl == nil || pl.done {
		return nil
	}
	return func(fn func()) {
		w.mu.Lock()
		if !pl.done {
			pl.fns = append(pl.fns, fn)
			w.mu.Unlock()
			return
		}
		w.mu.Unlock()
		go fn()
	}
}

func (w *Wails) pageLoaded(win *application.WebviewWindow) {
	w.mu.Lock()
	pl := w.loads[win]
	if pl == nil || pl.done {
		w.mu.Unlock()
		return
	}
	pl.done = true
	hostports.Stage("page-loaded " + win.Name())
	fns := pl.fns
	pl.fns = nil
	w.mu.Unlock()
	for _, fn := range fns {
		go fn()
	}
}

// create 新建窗口；at 非空时先隐藏建好、挪到 at 再显示（重建用，避免先在默认位置闪一下）
func (w *Wails) create(k shell.WindowKind, at *shell.Rect) *application.WebviewWindow {
	var opts application.WebviewWindowOptions
	var place func(win *application.WebviewWindow)
	switch k {
	case shell.Mascot:
		// 2.0.5 默认缩放 0.5：420×450 的一半 + 透明边距（60, 130）→ 330×355
		opts = application.WebviewWindowOptions{
			Name: "mascot", Title: "Nomi", Width: 330, Height: 355,
			Frameless: true, AlwaysOnTop: true, DisableResize: true,
			BackgroundType:   application.BackgroundTypeTransparent,
			BackgroundColour: application.RGBA{},
			Linux:            application.LinuxWindow{WindowIsTranslucent: true, WebviewGpuPolicy: application.WebviewGpuPolicyOnDemand},
			// mac/Windows 需要各自显式声明透明。Mac 上 WKWebView 只能用私有键 drawsBackground 关底色，
			// Wails v3.0.0 只在 -tags private_mac_apis 下编进去（否则是空实现 → 白底），见 macflags_darwin.go。
			Mac:     application.MacWindow{Backdrop: application.MacBackdropTransparent},
			Windows: application.WindowsWindow{HiddenOnTaskbar: true, BackdropType: application.None, DisableFramelessWindowDecorations: true},
			URL:     w.page(k),
			// 拖文件到角色身上 → 总结（renderer useFileDropSummarize 给画布加 data-file-drop-target）
			EnableFileDrop: w.cfg.OnFilesDropped != nil,
		}
		if w.cfg.MascotSize != nil {
			opts.Width, opts.Height = w.cfg.MascotSize(nil)
		}
		// 位置与按工作区夹紧的尺寸在原生窗口出来后再定（placeMascot）：第一个窗口建在 Run 之前，这时 Wails
		// 拿不到屏幕信息；建窗选项里的 Screen + WindowXY 在 mac 上还会把坐标再除一次缩放倍数（windowSetPositionOnScreen）
		if at == nil {
			place = func(win *application.WebviewWindow) { w.placeMascot(win) }
		}
	case shell.Island:
		opts = application.WebviewWindowOptions{
			Name: "island", Title: "Nomi Island", Width: 360, Height: 72,
			Frameless: true, AlwaysOnTop: true, DisableResize: true,
			InitialPosition:  application.WindowXY,
			BackgroundType:   application.BackgroundTypeTransparent,
			BackgroundColour: application.RGBA{},
			Linux:            application.LinuxWindow{WindowIsTranslucent: true},
			Mac:              application.MacWindow{Backdrop: application.MacBackdropTransparent, WindowLevel: application.MacWindowLevelStatus},
			Windows:          application.WindowsWindow{HiddenOnTaskbar: true, BackdropType: application.None, DisableFramelessWindowDecorations: true},
			URL:              w.page(k),
		}
		if w.cfg.IslandLayout != nil {
			if r, page, ok := w.cfg.IslandLayout(); ok {
				// 与 Electron 一样按 islandWindowRect 建窗（刘海模式顶到屏幕最上沿、无投影留白）；建好后用绝对坐标定位
				opts.Width, opts.Height, opts.URL = r.Width, r.Height, page
				at = &r
			}
		} else if sc := w.app.Screen.GetPrimary(); sc != nil {
			opts.Screen = sc
			opts.X = (sc.WorkArea.Width - opts.Width) / 2 // 相对 WorkArea 原点
			opts.Y = 8
		}
	case shell.Chat:
		// = buildAiChatWindow：默认 1120×820（小屏收缩）、最小 760×560；上次的位置大小在原生窗口出来后恢复（placeChat）
		// mac = titleBarOptions('darwin')：隐藏原生标题栏，红绿灯叠在 ai-chat 自绘的 38px 标题栏左侧
		// （Wails 的 HiddenInset 预设会加工具栏把标题区撑到约 52px，且不能设 trafficLightPosition）
		opts = application.WebviewWindowOptions{Name: "chat", Title: "Nomi 对话", Width: 1120, Height: 820,
			MinWidth: shell.ChatMinSize.Width, MinHeight: shell.ChatMinSize.Height, URL: w.page(k),
			// 拖入文件取本机路径（= preload nomiHost.pathForFile；ai-chat 给 body 加 data-file-drop-target）
			EnableFileDrop: w.cfg.OnFilesDropped != nil,
			Mac:            application.MacWindow{TitleBar: application.MacTitleBarHidden}}
		if at == nil {
			// 应用已起来（通常如此：对话窗口按需打开）：位置大小直接放进建窗选项。mac 上全尺寸内容的窗口建好后再
			// SetBounds 改大小，WKWebView 不重新布局（整页空白），所以不能事后摆
			if areas := w.primaryFirst(); len(areas) > 0 {
				b := w.chatBounds(areas)
				opts.Width, opts.Height = b.Width, b.Height
				w.initialXY(&opts, b.X, b.Y)
				if b.Maximized {
					opts.StartState = application.WindowStateMaximised
				}
			} else {
				place = w.placeChat // 启动前建的（没有托盘时的兜底窗口）：等屏幕信息出来再摆
			}
		}
	}
	w.mu.Lock()
	if on, ok := w.aot[k]; ok {
		opts.AlwaysOnTop = on
	}
	w.mu.Unlock()
	if at != nil {
		opts.Hidden = true
	}
	hostports.Stage("window-create " + string(k))
	win := w.app.Window.NewWithOptions(opts)
	w.mu.Lock()
	w.loads[win] = &pageLoad{}
	w.mu.Unlock()
	// did-finish-load：各平台 WebView 的页面加载完成事件（只有本平台的会触发）
	for _, ev := range []events.WindowEventType{events.Linux.WindowLoadFinished, events.Mac.WebViewDidFinishNavigation, events.Windows.WebViewNavigationCompleted} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { w.pageLoaded(win) })
	}
	if w.cfg.OnFilesDropped != nil {
		win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
			if files := e.Context().DroppedFiles(); len(files) > 0 {
				w.cfg.OnFilesDropped(k, files)
			}
		})
	}
	// 用户点关闭 = 销毁（WebView 一起释放）
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.mu.Lock()
		cur := w.wins[k] == win
		if cur {
			delete(w.wins, k)
		}
		delete(w.loads, win)
		w.mu.Unlock()
		if cur {
			w.notify(k, "closed")
			// 用户关的（Destroy 主动销毁时 cur 为 false）：= BrowserWindow 'close'（关闭看板娘即退出 / closeMain=quit）
			w.notify(k, "user-closed")
		}
	})
	for _, ev := range []events.WindowEventType{events.Common.WindowShow, events.Common.WindowRestore} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { w.notify(k, "shown") })
	}
	switch k {
	case shell.Mascot:
		// = setupMainWindowEvents onGeometryChange → 防抖保存 windowPosition（mascothandlers）
		win.OnWindowEvent(events.Common.WindowDidMove, func(*application.WindowEvent) { w.notify(k, "moved") })
	case shell.Chat:
		w.trackChatBounds(win)
	}
	w.mu.Lock()
	w.wins[k] = win
	w.mu.Unlock()
	if at != nil {
		win.SetBounds(application.Rect{X: at.X, Y: at.Y, Width: at.Width, Height: at.Height})
	}
	w.fireCreated(win)
	win.Show()
	// 控制器（物理 / 拖拽）在 created 时读窗口位置与工作区：要等原生窗口出来、摆好位置之后再通知
	w.afterNative(win, func() {
		if place != nil {
			place(win)
		}
		w.notify(k, "created")
	})
	return win
}

// afterNative：原生窗口已存在（Run 之前建的窗口要等应用起来，有时到首次显示）、屏幕信息已就绪后在 goroutine 里执行 fn
func (w *Wails) afterNative(win *application.WebviewWindow, f func()) {
	fn := func() {
		w.waitScreens()
		f()
	}
	w.whenStarted(func() {
		if win.NativeWindow() != nil {
			go fn()
			return
		}
		var once sync.Once
		var off func()
		off = win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
			once.Do(func() {
				if off != nil {
					off()
				}
				go fn()
			})
		})
	})
}

// waitScreens：mac 上 Wails 在 ApplicationDidFinishLaunching 才缓存屏幕，晚于 ApplicationStarted（实测约 300ms 内）；
// 在那之前 Screen.GetAll() 为空，按空屏幕摆窗口 / 启动物理会把看板娘放到 (0,0)。最多等 3s
func (w *Wails) waitScreens() {
	for i := 0; i < 150 && len(w.app.Screen.GetAll()) == 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
}

// primaryFirst：所有工作区，主屏排第一（= [primaryDisplay, ...others].map(d => d.workArea)）
func (w *Wails) primaryFirst() []shell.Rect {
	var out []shell.Rect
	p := w.app.Screen.GetPrimary()
	if p != nil {
		out = append(out, shell.Rect{X: p.WorkArea.X, Y: p.WorkArea.Y, Width: p.WorkArea.Width, Height: p.WorkArea.Height})
	}
	for _, s := range w.app.Screen.GetAll() {
		if p != nil && s.ID == p.ID {
			continue
		}
		out = append(out, shell.Rect{X: s.WorkArea.X, Y: s.WorkArea.Y, Width: s.WorkArea.Width, Height: s.WorkArea.Height})
	}
	return out
}

// placeMascot = buildMainWindow：尺寸按保存的缩放夹到主屏工作区，位置用保存的 windowPosition，无效时主屏右下角
func (w *Wails) placeMascot(win *application.WebviewWindow) {
	areas := w.primaryFirst()
	if len(areas) == 0 {
		return
	}
	work := areas[0]
	b := win.Bounds()
	width, height := b.Width, b.Height
	if w.cfg.MascotSize != nil {
		width, height = w.cfg.MascotSize(&work)
	}
	p := mascotInitialPos(w.cfg.MascotPos, work.Width, work.Height, width, height)
	win.SetBounds(application.Rect{X: p[0], Y: p[1], Width: width, Height: height})
}

// chatBounds = buildAiChatWindow：恢复上次的位置大小（按现在的显示器校正）与最大化，没有记录时居中默认尺寸
func (w *Wails) chatBounds(areas []shell.Rect) shell.SavedChatBounds {
	if w.cfg.ChatBounds != nil {
		return w.cfg.ChatBounds(areas)
	}
	return shell.ChatWindowBounds(nil, areas)
}

// initialXY：建窗选项里的屏幕绝对坐标。mac / Windows 不带 Screen 时按绝对坐标摆（mac 带 Screen 会把坐标再除一次
// 缩放倍数）；Linux 不带 Screen 时是相对工作区的，所以带上主屏并换成相对坐标
func (w *Wails) initialXY(opts *application.WebviewWindowOptions, x, y int) {
	opts.InitialPosition = application.WindowXY
	opts.X, opts.Y = x, y
	if goruntime.GOOS == "linux" {
		if sc := w.app.Screen.GetPrimary(); sc != nil {
			opts.Screen = sc
			opts.X, opts.Y = x-sc.WorkArea.X, y-sc.WorkArea.Y
		}
	}
}

// placeChat：启动前建的对话窗口，屏幕信息出来后再摆
func (w *Wails) placeChat(win *application.WebviewWindow) {
	areas := w.primaryFirst()
	if len(areas) == 0 {
		return
	}
	b := w.chatBounds(areas)
	win.SetBounds(application.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height})
	if b.Maximized {
		win.Maximise()
	}
}

// trackChatBounds = setupAiChatWindowEvents：移动 / 缩放后 500ms 防抖保存，关闭时立即保存；
// 最大化时记的是最大化之前的位置大小（= getNormalBounds）。几何在事件里（goroutine 中）读好缓存，
// 关闭时窗口可能已经销毁，只存缓存，不再查询窗口
func (w *Wails) trackChatBounds(win *application.WebviewWindow) {
	if w.cfg.SaveChatBounds == nil {
		return
	}
	var mu sync.Mutex
	var last *shell.SavedChatBounds
	var timer *time.Timer
	save := func() {
		mu.Lock()
		b := last
		mu.Unlock()
		if b != nil {
			w.cfg.SaveChatBounds(*b)
		}
	}
	refresh := func() {
		if win.IsMinimised() || win.IsFullscreen() {
			return // = saveBounds：最小化 / 全屏时不记
		}
		maxed := win.IsMaximised()
		r := win.Bounds()
		mu.Lock()
		defer mu.Unlock()
		next := shell.SavedChatBounds{Maximized: maxed}
		switch {
		case !maxed && r.Width > 0 && r.Height > 0:
			next.Rect = shell.Rect{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height}
		case last != nil:
			next.Rect = last.Rect // 最大化中：沿用最大化前的位置大小
		default:
			return
		}
		last = &next
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(500*time.Millisecond, save)
	}
	for _, ev := range []events.WindowEventType{events.Common.WindowDidMove, events.Common.WindowDidResize,
		events.Common.WindowMaximise, events.Common.WindowUnMaximise} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { go refresh() })
	}
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		mu.Lock()
		if timer != nil {
			timer.Stop()
		}
		mu.Unlock()
		go save()
	})
}

// notify 异步回调（回调里会同步读窗口状态，不能占着主线程）
func (w *Wails) notify(k shell.WindowKind, event string) {
	if w.cfg.OnWindow != nil {
		go w.cfg.OnWindow(k, event)
	}
}

func (w *Wails) Recreate(k shell.WindowKind) {
	old := w.win(k)
	if old == nil {
		return
	}
	b := old.Bounds()
	r := shell.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}
	application.InvokeSync(func() { w.create(k, &r) })
	// 新页面画出来前旧窗口留在原地，之后再关：只有一瞬间的替换，不露空
	time.AfterFunc(700*time.Millisecond, func() {
		application.InvokeSync(func() { old.Close() })
		log.Printf("[shell] %s recreated", k)
	})
}

// IsDarkMode = nativeTheme.shouldUseDarkColors（系统当前是否深色）
func (w *Wails) IsDarkMode() bool { return w.app.Env.IsDarkMode() }

// Hide 隐藏窗口但不销毁（= BrowserWindow.hide()）
func (w *Wails) Hide(k shell.WindowKind) {
	if win := w.win(k); win != nil {
		win.Hide()
	}
}

func (w *Wails) Destroy(k shell.WindowKind) {
	w.mu.Lock()
	win := w.wins[k]
	delete(w.wins, k)
	delete(w.loads, win)
	w.mu.Unlock()
	if win != nil {
		w.notify(k, "closed")
		win.Close()
		log.Printf("[shell] %s destroyed", k)
	}
}

func (w *Wails) Visible(k shell.WindowKind) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.wins[k] != nil
}

func (w *Wails) Run() error { return w.app.Run() }
func (w *Wails) Quit()      { w.app.Quit() }

func (w *Wails) win(k shell.WindowKind) *application.WebviewWindow {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.wins[k]
}

func (w *Wails) Bounds(k shell.WindowKind) (shell.Rect, bool) {
	win := w.win(k)
	if win == nil {
		return shell.Rect{}, false
	}
	b := win.Bounds()
	return shell.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}, true
}

func (w *Wails) SetBounds(k shell.WindowKind, r shell.Rect) {
	if win := w.win(k); win != nil {
		win.SetBounds(application.Rect{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height})
	}
}

func (w *Wails) SetAlwaysOnTop(k shell.WindowKind, on bool) {
	w.mu.Lock()
	w.aot[k] = on
	w.mu.Unlock()
	if win := w.win(k); win != nil {
		win.SetAlwaysOnTop(on)
	}
}

func (w *Wails) WorkAreas() []shell.WorkArea {
	var out []shell.WorkArea
	for _, s := range w.app.Screen.GetAll() {
		a := s.WorkArea
		out = append(out, shell.WorkArea{Rect: shell.Rect{X: a.X, Y: a.Y, Width: a.Width, Height: a.Height}, ScaleFactor: float64(s.ScaleFactor)})
	}
	return out
}

// PrimaryDisplay 主屏 bounds / workArea（DIP），供灵动岛刘海检测（D-B10-1）
func (w *Wails) PrimaryDisplay() (bounds, work shell.Rect, ok bool) {
	sc := w.app.Screen.GetPrimary()
	if sc == nil {
		return bounds, work, false
	}
	b, a := sc.Bounds, sc.WorkArea
	return shell.Rect{X: b.X, Y: b.Y, Width: b.Width, Height: b.Height}, shell.Rect{X: a.X, Y: a.Y, Width: a.Width, Height: a.Height}, true
}

func (w *Wails) Resizable(k shell.WindowKind) bool {
	if win := w.win(k); win != nil {
		return win.Resizable()
	}
	return false
}

func (w *Wails) SetResizable(k shell.WindowKind, on bool) {
	if win := w.win(k); win != nil {
		win.SetResizable(on)
	}
}

// mascotInitialPos = 2.0.4 WindowManager.createMainWindow：保存的位置在 (0, workAreaSize) 开区间内就用，
// 否则 x = 宽 - 窗宽、y = 高 - 窗高（主屏工作区右下角）。返回绝对坐标。
func mascotInitialPos(saved func() (int, int), areaW, areaH, width, height int) *[2]int {
	x, y := 0, 0
	if saved != nil {
		x, y = saved()
	}
	if x <= 0 || x >= areaW || y <= 0 || y >= areaH {
		x, y = areaW-width, areaH-height
	}
	return &[2]int{x, y}
}

func (w *Wails) SetPosition(k shell.WindowKind, x, y int) {
	if win := w.win(k); win != nil {
		win.SetPosition(x, y)
	}
}

func (w *Wails) Shown(k shell.WindowKind) (bool, bool) {
	if win := w.win(k); win != nil {
		return win.IsVisible(), win.IsMinimised()
	}
	return false, false
}

func (w *Wails) SetIgnoreMouse(k shell.WindowKind, ignore bool) {
	if win := w.win(k); win != nil {
		win.SetIgnoreMouseEvents(ignore)
	}
}

func (w *Wails) SetInputShape(k shell.WindowKind, rects []shell.Rect) {
	if win := w.win(k); win != nil {
		nativeInputShape(win, rects)
	}
}

func (w *Wails) CursorPosition() (int, int) { return nativeCursor(w.app) }

var _ shell.WindowControl = (*Wails)(nil)
var _ shell.Shell = (*Wails)(nil)
var _ shell.Geometry = (*Wails)(nil)

// ExecJS 在窗口页面里执行脚本（= webContents.executeJavaScript，但拿不到返回值）
func (w *Wails) ExecJS(k shell.WindowKind, js string) {
	if win := w.win(k); win != nil {
		win.ExecJS(js)
	}
}

// AnyFocused = BrowserWindow.getFocusedWindow() != null：任一应用窗口处于焦点（b7 WindowFocus 接口）
func (w *Wails) AnyFocused() bool {
	w.mu.Lock()
	ws := make([]*application.WebviewWindow, 0, len(w.wins))
	for _, win := range w.wins {
		if win != nil {
			ws = append(ws, win)
		}
	}
	w.mu.Unlock()
	for _, win := range ws {
		if win.IsFocused() {
			return true
		}
	}
	return false
}
