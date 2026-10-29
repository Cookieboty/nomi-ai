// Package wailsshell：Shell 的 Wails v3 实现。只做窗口、托盘、系统集成；不含业务。
package wailsshell

import (
	"io/fs"
	"log"
	"net/url"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/icons"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

type Config struct {
	Assets fs.FS
	// Fragment 附在页面地址后（WS 地址与 token，片段不发给服务器）
	Fragment url.Values
}

type Wails struct {
	app  *application.App
	cfg  Config
	mu   sync.Mutex
	wins map[shell.WindowKind]*application.WebviewWindow
	tray *application.SystemTray
}

func New(cfg Config) *Wails {
	w := &Wails{cfg: cfg, wins: map[shell.WindowKind]*application.WebviewWindow{}}
	w.app = application.New(application.Options{
		Name:    "Nomi",
		Assets:  application.AssetOptions{Handler: application.AssetFileServerFS(cfg.Assets)},
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
		if sc := w.app.Screen.GetPrimary(); sc != nil {
			opts.Screen = sc
			opts.X = (sc.WorkArea.Width - opts.Width) / 2 // 相对 WorkArea 原点
			opts.Y = 8
		}
	case shell.Chat:
		opts = application.WebviewWindowOptions{Name: "chat", Title: "Nomi 对话", Width: 480, Height: 560, URL: w.page(k)}
	}
	win = w.app.Window.NewWithOptions(opts)
	// 用户点关闭 = 销毁（WebView 一起释放）
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.mu.Lock()
		if w.wins[k] == win {
			delete(w.wins, k)
		}
		w.mu.Unlock()
	})
	w.mu.Lock()
	w.wins[k] = win
	w.mu.Unlock()
	win.Show()
}

func (w *Wails) Destroy(k shell.WindowKind) {
	w.mu.Lock()
	win := w.wins[k]
	delete(w.wins, k)
	w.mu.Unlock()
	if win != nil {
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

var _ shell.Shell = (*Wails)(nil)
