//go:build windows

package wailsshell

import (
	"errors"
	"sync"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// Windows 的载体：WebView2 窗口用 SetParent 挂成对话窗口的子窗口（WS_CHILD）。
//
// 为什么不是独立窗口：独立窗口是顶层窗口，层级由系统管，会浮在对话窗口之上盖住设置页和弹层，
// 还要前端不停算屏幕坐标去贴。做成子窗口之后，坐标是「相对父窗口客户区」，并被父窗口裁剪，
// 父窗口移动 / 最小化时子窗口跟着走——和 macOS 的子视图是同一个模型。
//
// 页面本身仍是顶层文档（不是 iframe），X-Frame-Options / frame-ancestors 不参与判定。
type winBrowser struct {
	win *application.WebviewWindow
	w   *Wails
	mu  sync.Mutex
}

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procGetWindowLongPtr = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtr = user32.NewProc("SetWindowLongPtrW")
	procSetParent        = user32.NewProc("SetParent")
	procSetWindowPos     = user32.NewProc("SetWindowPos")
	procShowWindow       = user32.NewProc("ShowWindow")
	procGetParent        = user32.NewProc("GetParent")
	procGetFocus         = user32.NewProc("GetFocus")
	procGetForeground    = user32.NewProc("GetForegroundWindow")
)

// focusedWindow：当前线程的焦点窗口（GetFocus；焦点不在本线程的窗口上时为 0）
func focusedWindow() uintptr {
	focused, _, _ := procGetFocus.Call()
	return focused
}

// foregroundWindow：系统当前的前台窗口
func foregroundWindow() uintptr {
	hwnd, _, _ := procGetForeground.Call()
	return hwnd
}

const (
	gwlStyle = ^uintptr(15) // GWL_STYLE = -16

	wsChild = 0x40000000
	wsPopup = 0x80000000

	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010

	swHide = 0
	swShow = 8 // SW_SHOWNA：显示但不抢激活，用户正在对话窗口里打字
)

func (w *Wails) newBrowserView(id, target string, region shell.BrowserRegion, ev browserViewEvents) (browserView, error) {
	chat := w.win(shell.Chat)
	if chat == nil {
		return nil, errors.New("no chat window")
	}
	parent := uintptr(chat.NativeWindow())
	if parent == 0 {
		return nil, errors.New("no native window")
	}
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
		// 加载完成后注入：把 target=_blank / window.open 改成当前窗口导航
		JS:      browserPopupJS,
		Windows: application.WindowsWindow{HiddenOnTaskbar: true, DisableFramelessWindowDecorations: true},
	}
	win := w.app.Window.NewWithOptions(opts)
	b := &winBrowser{win: win, w: w}
	win.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
		ev.Loaded(true, "")
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		if ev.Closed != nil {
			ev.Closed()
		}
	})
	// 原生窗口出来之后才能改父子关系；先藏着，摆好位置再显示
	w.afterNative(win, func() {
		b.mu.Lock()
		ok := b.adopt(parent)
		b.mu.Unlock()
		if ok {
			b.SetRegion(region)
		}
	})
	return b, nil
}

// adopt：顶层窗口 → 父窗口的子窗口
func (b *winBrowser) adopt(parent uintptr) bool {
	child := uintptr(b.win.NativeWindow())
	if child == 0 || parent == 0 {
		return false
	}
	style, _, _ := procGetWindowLongPtr.Call(child, gwlStyle)
	style = (style &^ wsPopup) | wsChild
	if _, _, err := procSetWindowLongPtr.Call(child, gwlStyle, style); err != nil && err.Error() != "The operation completed successfully." {
		return false
	}
	if _, _, err := procSetParent.Call(child, parent); err != nil && err.Error() != "The operation completed successfully." {
		return false
	}
	return true
}

// scale：DIP → 物理像素（区域是 CSS px，SetWindowPos 要物理像素）
func (b *winBrowser) scale() float64 {
	chat := b.w.win(shell.Chat)
	if chat == nil {
		return 1
	}
	logical, physical := chat.Bounds(), chat.PhysicalBounds()
	if logical.Width <= 0 {
		return 1
	}
	s := float64(physical.Width) / float64(logical.Width)
	if s <= 0 {
		return 1
	}
	return s
}

func (b *winBrowser) SetRegion(region shell.BrowserRegion) bool {
	if !usableRegion(region) {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	child := uintptr(b.win.NativeWindow())
	if child == 0 {
		return false
	}
	s := b.scale()
	x := int32(float64(region.X) * s)
	y := int32(float64(region.Y) * s)
	w := int32(float64(region.Width) * s)
	h := int32(float64(region.Height) * s)
	procSetWindowPos.Call(child, 0,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		swpNoZOrder|swpNoActivate)
	return true
}

func (b *winBrowser) Show() {
	if child := uintptr(b.win.NativeWindow()); child != 0 {
		procShowWindow.Call(child, swShow)
	}
}

func (b *winBrowser) Hide() {
	child := uintptr(b.win.NativeWindow())
	if child == 0 {
		return
	}
	b.w.withBrowserFocusReturned(child, func() { procShowWindow.Call(child, swHide) })
}

// withBrowserFocusReturned：藏 / 关浏览器子窗口；它（或它里面的网页控件）原来拿着键盘焦点时，
// 之后把焦点还给对话窗口的 WebView2。
//
// 子窗口藏起来 / 关掉之后 Windows 不会替我们交还焦点（焦点落在父窗口上或者没有焦点，对话页面
// 收不到键盘消息）。焦点得在藏之前看：藏完 GetFocus 已经不在子窗口上了，看不出原来在谁身上。
// GetFocus 只认调用线程的消息队列，所以判断和藏都放在 UI 线程上做；对话窗口自己的页面拿着焦点、
// 或者别的应用在前台时什么都不动。
func (w *Wails) withBrowserFocusReturned(child uintptr, hide func()) {
	chat := w.win(shell.Chat)
	held := false
	application.InvokeSync(func() {
		if chat != nil {
			parent := uintptr(chat.NativeWindow())
			held = browserHoldsKeyboardFocus(foregroundWindow() == parent, child, focusedWindow(), parentWindow)
		}
		hide()
	})
	// Focus 自己会切到 UI 线程，走 WebView2 控制器的 MoveFocus（只 SetFocus 到窗口，页面仍收不到键盘）
	if held && chat != nil {
		chat.Focus()
	}
}

func (b *winBrowser) Load(target string) { b.win.SetURL(target) }

func (b *winBrowser) Reload() { b.win.Reload() }

func (b *winBrowser) Close() {
	child := uintptr(b.win.NativeWindow())
	if child == 0 {
		b.win.Close()
		return
	}
	// 关之前先藏（并看焦点在不在它身上）：关窗口的过程里焦点控件会失效，之后就看不出原来在谁身上
	b.w.withBrowserFocusReturned(child, func() { procShowWindow.Call(child, swHide) })
	b.win.Close()
}

// followChatBrowser：子窗口跟着父窗口走 / 缩放，不需要额外同步
func (w *Wails) followChatBrowser(*application.WebviewWindow) {}

// closeStrayBrowser：按窗口名收掉不在记录里的残留窗口
func (w *Wails) closeStrayBrowser(id string) {
	if w.app == nil || w.app.Window == nil {
		return
	}
	if win, ok := w.app.Window.Get(browserName(id)); ok && win != nil {
		win.Close()
	}
}

// parentWindow：HWND 的父窗口（GetParent；顶层窗口返回 0）
func parentWindow(node uintptr) uintptr {
	parent, _, _ := procGetParent.Call(node)
	return parent
}
