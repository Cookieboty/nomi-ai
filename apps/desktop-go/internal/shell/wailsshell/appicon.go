package wailsshell

import (
	"log"
	"os"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// IconWindow：appicon.Window 的 Wails 实现（= BrowserWindow.setIcon / setAppDetails）
type IconWindow struct{ win *application.WebviewWindow }

func (iw IconWindow) IsDestroyed() bool { return iw.win == nil || iw.win.NativeWindow() == nil }

func (iw IconWindow) SetIcon(pngPath string) {
	b, err := os.ReadFile(pngPath)
	if err != nil {
		return
	}
	application.InvokeSync(func() {
		if p := iw.win.NativeWindow(); p != nil {
			nativeSetWindowIcon(p, b)
		}
	})
}

func (iw IconWindow) SetAppDetails(appID, iconPath string, index int) {
	application.InvokeSync(func() {
		if p := iw.win.NativeWindow(); p != nil {
			if err := nativeSetAppDetails(p, appID, iconPath, index); err != nil {
				log.Printf("[appIcon] setAppDetails: %v", err)
			}
		}
	})
}

// IconWindows = BrowserWindow.getAllWindows（appicon.Target）
func (w *Wails) IconWindows() []IconWindow {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]IconWindow, 0, len(w.wins))
	for _, k := range []shell.WindowKind{shell.Mascot, shell.Chat, shell.Island} {
		if win := w.wins[k]; win != nil {
			out = append(out, IconWindow{win})
		}
	}
	return out
}

// SetDockIcon = app.dock.setIcon（macOS：NSApp.applicationIconImage）
func (w *Wails) SetDockIcon(pngPath string) {
	b, err := os.ReadFile(pngPath)
	if err != nil || len(b) == 0 {
		return
	}
	w.whenStarted(func() { application.InvokeSync(func() { w.app.SetIcon(b) }) })
}

// SetTrayIcon = TrayManager onTrayIcon → tray.setImage（非 macOS；macOS 托盘保持模板图）
func (w *Wails) SetTrayIcon(pngPath string) {
	if runtime.GOOS == "darwin" || w.tray == nil {
		return
	}
	// tray.png 的 @2x 版本（与 nativeImage.createFromPath 在高分屏取 @2x 一致；托盘初始图同样用 @2x）
	b, err := os.ReadFile(pngPath[:len(pngPath)-len(".png")] + "@2x.png")
	if err != nil {
		if b, err = os.ReadFile(pngPath); err != nil {
			return
		}
	}
	w.tray.SetIcon(b)
}

// OnWindowCreated = app.on('browser-window-created')：每个新建窗口（含重建）同步回调
func (w *Wails) OnWindowCreated(fn func(IconWindow)) {
	w.mu.Lock()
	w.created = append(w.created, fn)
	w.mu.Unlock()
}

func (w *Wails) fireCreated(win *application.WebviewWindow) {
	w.mu.Lock()
	fns := append([]func(IconWindow){}, w.created...)
	w.mu.Unlock()
	run := func() {
		for _, fn := range fns {
			fn(IconWindow{win})
		}
	}
	// 启动前建的窗口：原生窗口要等事件循环起来（有时到首次显示）才存在
	w.whenStarted(func() {
		if win.NativeWindow() != nil {
			run()
			return
		}
		var off func()
		off = win.OnWindowEvent(events.Common.WindowShow, func(*application.WindowEvent) {
			if off != nil {
				off()
			}
			go run()
		})
	})
}

// whenStarted：应用跑起来之后才能动 NSApp / GTK
func (w *Wails) whenStarted(fn func()) {
	w.mu.Lock()
	if w.started {
		w.mu.Unlock()
		fn()
		return
	}
	w.pending = append(w.pending, fn)
	w.mu.Unlock()
}

func (w *Wails) hookStarted() {
	w.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		w.mu.Lock()
		w.started = true
		p := w.pending
		w.pending = nil
		w.mu.Unlock()
		for _, fn := range p {
			go fn()
		}
	})
}
