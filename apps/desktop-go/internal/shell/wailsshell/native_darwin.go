//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// = Electron ScreenMac::GetCursorScreenPoint：以主屏左上为原点、y 向下。
// 在 Go 线程上每秒调用几十次（mousetrack、桌面角色 tick）：这些线程没有自动释放池，自动释放的对象要靠这里的池回收
static void nomi_cursor(int *x, int *y) {
	@autoreleasepool {
		NSPoint p = [NSEvent mouseLocation];
		NSArray *ss = [NSScreen screens];
		CGFloat h = ss.count ? NSMaxY([(NSScreen *)ss[0] frame]) : 0;
		*x = (int)p.x;
		*y = (int)(h - p.y);
	}
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func nativeCursor(*application.App) (int, int) {
	var x, y C.int
	C.nomi_cursor(&x, &y)
	return int(x), int(y)
}

func nativeInputShape(*application.WebviewWindow, []shell.Rect) {}

// macOS 窗口没有独立图标（= applyToWindow 在 darwin 直接返回），Dock 走 App.SetIcon
func nativeSetWindowIcon(unsafe.Pointer, []byte)                    {}
func nativeSetAppDetails(unsafe.Pointer, string, string, int) error { return nil }
