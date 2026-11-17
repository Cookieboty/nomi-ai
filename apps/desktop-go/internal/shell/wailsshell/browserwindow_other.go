//go:build !windows && !darwin

package wailsshell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// 没有原生子视图可用的平台（Linux，以及其它非 mac/Windows 目标）：退回**独立无边框窗口**。
//
// 这是这一档的已知短板：顶层窗口的层级由系统管，会浮在对话窗口之上（设置页、弹层盖不住它），
// 位置要靠「视图报的区域 + 对话窗口在屏幕上的位置」算出来，对话窗口一动就要重新贴。
// macOS 走 WKWebView 子视图、Windows 走 SetParent 子窗口，没有这些问题。

type windowBrowser struct {
	win *application.WebviewWindow
	w   *Wails
}

func (w *Wails) newBrowserView(id, target string, region shell.BrowserRegion, ev browserViewEvents) (browserView, error) {
	opts := application.WebviewWindowOptions{
		Name:             browserName(id),
		Title:            "Nomi",
		URL:              target,
		Width:            minBrowserWidth,
		Height:           minBrowserHeight,
		Frameless:        true,
		DisableResize:    true,
		Hidden:           true,
		BackgroundColour: application.NewRGB(255, 255, 255),
		JS:               browserPopupJS,
		Linux:            application.LinuxWindow{WindowIsTranslucent: false},
	}
	win := w.app.Window.NewWithOptions(opts)
	b := &windowBrowser{win: win, w: w}
	win.OnWindowEvent(events.Linux.WindowLoadFinished, func(*application.WindowEvent) { ev.Loaded(true, "") })
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		if ev.Closed != nil {
			ev.Closed()
		}
	})
	b.SetRegion(region)
	return b, nil
}

func (b *windowBrowser) SetRegion(region shell.BrowserRegion) bool {
	if !usableRegion(region) {
		return false
	}
	rect, ok := b.w.browserBounds(region)
	if !ok {
		return false
	}
	b.win.SetBounds(rect)
	return true
}

func (b *windowBrowser) Show() { b.win.Show() }

func (b *windowBrowser) Hide() { b.win.Hide() }

func (b *windowBrowser) Load(target string) { b.win.SetURL(target) }

func (b *windowBrowser) Reload() { b.win.Reload() }

func (b *windowBrowser) Close() { b.win.Close() }

// followChatBrowser：独立窗口不会跟着对话窗口走，移动 / 缩放后要重新贴
func (w *Wails) followChatBrowser(win *application.WebviewWindow) {
	for _, ev := range []events.WindowEventType{events.Common.WindowDidMove, events.Common.WindowDidResize} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { w.reflowBrowsers(true) })
	}
	win.OnWindowEvent(events.Common.WindowMinimise, func(*application.WindowEvent) { w.hideBrowsers() })
}

// closeStrayBrowser：按窗口名收掉不在记录里的残留窗口
func (w *Wails) closeStrayBrowser(id string) {
	if w.app == nil || w.app.Window == nil {
		return
	}
	if win, ok := w.app.Window.Get(browserName(id)); ok && win != nil {
		win.Close()
	}
}

// browserBounds：区域（相对对话窗口内容区）→ 屏幕绝对坐标（DIP）
func (w *Wails) browserBounds(region shell.BrowserRegion) (application.Rect, bool) {
	chat := w.win(shell.Chat)
	if chat == nil {
		return application.Rect{}, false
	}
	offX, offY := 0, 0
	if bs := chat.GetBorderSizes(); bs != nil {
		offX, offY = bs.Left, bs.Top
	}
	return browserRect(chat.Bounds(), offX, offY, region)
}
