//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// = Electron ScreenMac::GetCursorScreenPoint：以主屏左上为原点、y 向下
static void nomi_cursor(int *x, int *y) {
	NSPoint p = [NSEvent mouseLocation];
	NSArray *ss = [NSScreen screens];
	CGFloat h = ss.count ? NSMaxY([(NSScreen *)ss[0] frame]) : 0;
	*x = (int)p.x;
	*y = (int)(h - p.y);
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func nativeCursor(*application.App) (int, int) {
	var x, y C.int
	C.nomi_cursor(&x, &y)
	return int(x), int(y)
}

func nativeInputShape(*application.WebviewWindow, []shell.Rect) {}
