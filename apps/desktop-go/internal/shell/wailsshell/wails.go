// Package wailsshell：Shell 的 Wails v3 实现。只做窗口、托盘、系统集成；不含业务。
package wailsshell

import (
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

type Config struct {
	Assets fs.FS
	// Fragment 附在页面地址后（WS 地址与 token，片段不发给服务器）
	Fragment url.Values
	// MascotSize 返回看板娘窗口初始大小（按保存的缩放）；nil 时用 330×355
	MascotSize func() (int, int)
	// OnWindow：窗口生命周期（"created" 新建或重建完成 / "closed" 当前窗口关闭 / "shown" show·restore）
	OnWindow func(k shell.WindowKind, event string)
	// Middleware 挂在资产服务器上（chat-asset:// / character-pack:// 网关，见 assetproto）
	Middleware func(http.Handler) http.Handler
	// IslandLayout：灵动岛窗口矩形（islandWindowRect(g, g.height)，屏幕绝对坐标）与页面地址；nil/false 用占位页
	IslandLayout func() (rect shell.Rect, page string, ok bool)
}

type Wails struct {
	app  *application.App
	cfg  Config
	mu   sync.Mutex
	wins map[shell.WindowKind]*application.WebviewWindow
	tray *application.SystemTray
	aot  map[shell.WindowKind]bool // SetAlwaysOnTop 记下的状态（重建时沿用）
}

func New(cfg Config) *Wails {
	w := &Wails{cfg: cfg, wins: map[shell.WindowKind]*application.WebviewWindow{}, aot: map[shell.WindowKind]bool{}}
	w.app = application.New(application.Options{
		Name:    "Nomi",
		Assets:  application.AssetOptions{Handler: application.AssetFileServerFS(cfg.Assets), Middleware: cfg.Middleware},
		Mac:     application.MacOptions{ActivationPolicy: application.ActivationPolicyAccessory, ApplicationShouldTerminateAfterLastWindowClosed: false},
		Linux:   application.LinuxOptions{DisableQuitOnLastWindowClosed: true, ProgramName: "nomi-poc"},
		Windows: application.WindowsOptions{DisableQuitOnLastWindowClosed: true},
	})
	if trayHostAvailable() {
		w.setupTray()
	} else {
		log.Printf("[shell] no system tray host (StatusNotifierWatcher); running tray-less")
	}
	return w
}

func (w *Wails) setupTray() {
	t := w.app.SystemTray.New()
	t.SetIcon(icons.WailsLogoBlackTransparent)
	t.SetLabel("Nomi")
	m := w.app.NewMenu()
	m.Add("显示 / 隐藏看板娘").OnClick(func(*application.Context) { w.toggle(shell.Mascot) })
	m.Add("打开 / 关闭对话").OnClick(func(*application.Context) { w.toggle(shell.Chat) })
	m.Add("显示通知条").OnClick(func(*application.Context) { w.toggle(shell.Island) })
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
	return "/" + string(k) + ".html#" + w.cfg.Fragment.Encode()
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

// create 新建窗口；at 非空时先隐藏建好、挪到 at 再显示（重建用，避免先在默认位置闪一下）
func (w *Wails) create(k shell.WindowKind, at *shell.Rect) *application.WebviewWindow {
	var opts application.WebviewWindowOptions
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
		}
		if w.cfg.MascotSize != nil {
			opts.Width, opts.Height = w.cfg.MascotSize()
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
		opts = application.WebviewWindowOptions{Name: "chat", Title: "Nomi 对话", Width: 480, Height: 560, URL: w.page(k)}
	}
	w.mu.Lock()
	if on, ok := w.aot[k]; ok {
		opts.AlwaysOnTop = on
	}
	w.mu.Unlock()
	if at != nil {
		opts.Hidden = true
	}
	win := w.app.Window.NewWithOptions(opts)
	// 用户点关闭 = 销毁（WebView 一起释放）
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.mu.Lock()
		cur := w.wins[k] == win
		if cur {
			delete(w.wins, k)
		}
		w.mu.Unlock()
		if cur {
			w.notify(k, "closed")
		}
	})
	for _, ev := range []events.WindowEventType{events.Common.WindowShow, events.Common.WindowRestore} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { w.notify(k, "shown") })
	}
	w.mu.Lock()
	w.wins[k] = win
	w.mu.Unlock()
	if at != nil {
		win.SetBounds(application.Rect{X: at.X, Y: at.Y, Width: at.Width, Height: at.Height})
	}
	win.Show()
	w.notify(k, "created")
	return win
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

func (w *Wails) Destroy(k shell.WindowKind) {
	w.mu.Lock()
	win := w.wins[k]
	delete(w.wins, k)
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
