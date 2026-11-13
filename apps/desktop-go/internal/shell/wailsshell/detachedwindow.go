package wailsshell

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	goruntime "runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// 对话标签弹出来的独立窗口（core/tabwindows 管开关与事件，这里只建原生窗口）：
// 和对话窗口同一个页面（/chat/index.html?<query>），自己一份 chat 面 token（窗口关闭时撤销），
// 页面按 ?detached= 只画那一个子任务 / 文件。不进 w.wins（不是桌面角色控制器认识的窗口种类），
// 关掉不触发 OnWindow，也不影响「关闭主界面时退出」。

// detachedSize：默认大小（够放一列对话 + 输入栏）与最小大小
var (
	detachedSize    = shell.Rect{Width: 760, Height: 820}
	detachedMinSize = shell.Rect{Width: 420, Height: 360}
)

// detachedName：Wails 窗口名（只用于日志 / 区分），不直接用 id（可能很长、带任意字符）
func detachedName(id string) string {
	sum := sha1.Sum([]byte(id))
	return "detached-" + hex.EncodeToString(sum[:6])
}

// detachedURL：页面地址 = 对话页 + ?query + #片段（片段里是 ws 地址与 token，不发给服务器）
func detachedURL(page, query, frag string) string {
	u := page
	if query != "" {
		u += "?" + query
	}
	if frag != "" {
		u += "#" + frag
	}
	return u
}

// OpenDetached 新建一个弹出窗口；onClosed 在窗口关闭（用户关、CloseDetached、应用退出）时调用
func (w *Wails) OpenDetached(id, title, query string, onClosed func()) error {
	page := w.cfg.Pages[shell.Chat]
	if page == "" {
		return errors.New("no chat page")
	}
	frag, release := "", func() {}
	if w.cfg.Fragment != nil {
		v, rel := w.cfg.Fragment(shell.Chat)
		frag = v.Encode()
		if rel != nil {
			release = rel
		}
	}
	opts := application.WebviewWindowOptions{
		Name: detachedName(id), Title: title,
		Width: detachedSize.Width, Height: detachedSize.Height,
		MinWidth: detachedMinSize.Width, MinHeight: detachedMinSize.Height,
		URL: detachedURL(page, query, frag),
		// 和对话窗口一样：mac 隐藏原生标题栏（红绿灯叠在页面自绘的标题栏上），Windows / Linux 无边框、按钮自绘
		Mac:         application.MacWindow{TitleBar: application.MacTitleBarHidden},
		Frameless:   goruntime.GOOS != "darwin",
		Permissions: mediaPolicy,
	}
	win := w.app.Window.NewWithOptions(opts)
	w.mu.Lock()
	w.detached[id] = win
	w.mu.Unlock()
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.mu.Lock()
		if w.detached[id] == win {
			delete(w.detached, id)
		}
		w.mu.Unlock()
		release()
		if onClosed != nil {
			go onClosed()
		}
	})
	w.fireCreated(win)
	win.Show()
	w.afterNative(win, func() { placeTrafficLights(win) })
	return nil
}

func (w *Wails) detachedWin(id string) *application.WebviewWindow {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.detached[id]
}

// FocusDetached 把已开着的弹出窗口提到最前
func (w *Wails) FocusDetached(id string) {
	if win := w.detachedWin(id); win != nil {
		if win.IsMinimised() {
			win.Restore()
		}
		win.Show()
		win.Focus()
	}
}

// CloseDetached 关掉弹出窗口（WindowClosing 里撤销 token、通知 onClosed）
func (w *Wails) CloseDetached(id string) {
	if win := w.detachedWin(id); win != nil {
		win.Close()
	}
}
