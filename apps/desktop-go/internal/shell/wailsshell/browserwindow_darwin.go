//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>

// 具体实现在 browserwindow_darwin.m（Objective-C 类不能写在带 //export 的文件里）
void *nomiBrowserCreate(void *nsWindow, int handle, double x, double y, double w, double h, const char *url);
void nomiBrowserSetRegion(void *view, double x, double y, double w, double h);
void nomiBrowserSetHidden(void *view, int hidden);
void nomiBrowserLoad(void *view, const char *url);
void nomiBrowserReload(void *view);
void nomiBrowserClose(void *view);
double nomiBrowserContentHeight(void *nsWindow);
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// macOS 的载体：WKWebView 作为对话窗口 contentView 的子视图。
//
// 为什么这样做：网页必须是顶层文档（iframe 会被 X-Frame-Options / frame-ancestors 拒掉），
// 但载体如果是独立窗口，它就有自己的层级——会浮在对话窗口之上盖住设置页、弹层，
// 且要前端不停算屏幕坐标去贴，界面一动就错位。做成子视图之后：随窗口移动 / 缩放、
// 被窗口裁剪、最小化跟着消失，坐标只需要「相对内容区」这一套。
type darwinBrowser struct {
	handle C.int
	view   unsafe.Pointer
	w      *Wails
	events browserViewEvents
}

var (
	darwinBrowsersMu sync.Mutex
	darwinBrowsers   = map[C.int]*darwinBrowser{}
	darwinNextHandle C.int
)

func (w *Wails) newBrowserView(id, target string, region shell.BrowserRegion, ev browserViewEvents) (browserView, error) {
	chat := w.win(shell.Chat)
	if chat == nil {
		return nil, errors.New("no chat window")
	}
	ns := chat.NativeWindow()
	if ns == nil {
		return nil, errors.New("no native window")
	}
	b := &darwinBrowser{w: w, events: ev}
	darwinBrowsersMu.Lock()
	darwinNextHandle++
	b.handle = darwinNextHandle
	darwinBrowsers[b.handle] = b
	darwinBrowsersMu.Unlock()

	// 初始位置摆得准就摆，摆不准先用最小尺寸藏着——等视图报区域再摆，不能因此报错
	x, y, width, height := 0.0, 0.0, float64(minBrowserWidth), float64(minBrowserHeight)
	if vx, vy, vw, vh, ok := regionToView(region, float64(C.nomiBrowserContentHeight(ns))); ok {
		x, y, width, height = vx, vy, vw, vh
	}
	targetURL := C.CString(target)
	defer C.free(unsafe.Pointer(targetURL))

	var view unsafe.Pointer
	application.InvokeSync(func() {
		view = C.nomiBrowserCreate(ns, b.handle, C.double(x), C.double(y), C.double(width), C.double(height), targetURL)
	})
	if view == nil {
		darwinBrowsersMu.Lock()
		delete(darwinBrowsers, b.handle)
		darwinBrowsersMu.Unlock()
		return nil, errors.New("create webview failed")
	}
	b.view = view
	return b, nil
}

func (b *darwinBrowser) SetRegion(region shell.BrowserRegion) bool {
	if b.view == nil {
		return false
	}
	chat := b.w.win(shell.Chat)
	if chat == nil {
		return false
	}
	ns := chat.NativeWindow()
	if ns == nil {
		return false
	}
	x, y, w, h, ok := regionToView(region, float64(C.nomiBrowserContentHeight(ns)))
	if !ok {
		return false
	}
	view := b.view
	application.InvokeSync(func() {
		C.nomiBrowserSetRegion(view, C.double(x), C.double(y), C.double(w), C.double(h))
	})
	return true
}

func (b *darwinBrowser) Show() { b.setHidden(false) }
func (b *darwinBrowser) Hide() { b.setHidden(true) }

func (b *darwinBrowser) setHidden(hidden bool) {
	if b.view == nil {
		return
	}
	flag := C.int(0)
	if hidden {
		flag = 1
	}
	view := b.view
	application.InvokeSync(func() {
		C.nomiBrowserSetHidden(view, flag)
	})
}

func (b *darwinBrowser) Load(target string) {
	if b.view == nil {
		return
	}
	view := b.view
	text := C.CString(target)
	application.InvokeSync(func() {
		C.nomiBrowserLoad(view, text)
	})
	C.free(unsafe.Pointer(text))
}

func (b *darwinBrowser) Reload() {
	if b.view == nil {
		return
	}
	view := b.view
	application.InvokeSync(func() { C.nomiBrowserReload(view) })
}

func (b *darwinBrowser) Close() {
	darwinBrowsersMu.Lock()
	delete(darwinBrowsers, b.handle)
	darwinBrowsersMu.Unlock()
	if b.view == nil {
		return
	}
	view := b.view
	b.view = nil
	application.InvokeSync(func() { C.nomiBrowserClose(view) })
}

// followChatBrowser：子视图跟着窗口走，不需要额外同步
func (w *Wails) followChatBrowser(*application.WebviewWindow) {}

// closeStrayBrowser：子视图挂在窗口上，窗口一关就没了，没有可残留的独立窗口
func (w *Wails) closeStrayBrowser(string) {}

//export nomiBrowserDidLoad
func nomiBrowserDidLoad(handle C.int, ok C.int, message *C.char) {
	darwinBrowsersMu.Lock()
	b := darwinBrowsers[handle]
	darwinBrowsersMu.Unlock()
	if b == nil || b.events.Loaded == nil {
		return
	}
	msg := ""
	if message != nil {
		msg = C.GoString(message)
	}
	b.events.Loaded(ok != 0, msg)
}
