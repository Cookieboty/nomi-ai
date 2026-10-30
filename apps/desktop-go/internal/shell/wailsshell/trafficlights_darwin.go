//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// = Electron NativeWindowMac::RedrawTrafficLights（trafficLightPosition）：标题栏容器高度 = 按钮高 + 2·y，
// 按钮从 x 起横排、在容器里竖直居中
static void nomi_place_traffic_lights(NSWindow *w, CGFloat x, CGFloat y) {
	NSButton *close = [w standardWindowButton:NSWindowCloseButton];
	NSButton *mini = [w standardWindowButton:NSWindowMiniaturizeButton];
	NSButton *zoom = [w standardWindowButton:NSWindowZoomButton];
	if (!close || !mini || !zoom || w.styleMask & NSWindowStyleMaskFullScreen) return;
	NSView *container = close.superview.superview;
	if (!container) return;
	CGFloat h = NSHeight(close.frame) + 2 * y;
	// 已经在位就不动（DidUpdate 每轮事件循环都会来）
	if (NSMinX(close.frame) == x && NSHeight(container.frame) == h && NSMinY(close.frame) == (h - NSHeight(close.frame)) / 2) return;
	NSRect f = container.frame;
	f.size.height = h;
	f.origin.y = NSHeight(w.frame) - h;
	container.frame = f;
	CGFloat gap = NSMinX(mini.frame) - NSMinX(close.frame);
	NSArray<NSButton *> *bs = @[ close, mini, zoom ];
	for (NSUInteger i = 0; i < bs.count; i++) {
		NSRect r = bs[i].frame;
		r.origin.x = x + i * gap;
		r.origin.y = (h - NSHeight(r)) / 2;
		[bs[i] setFrameOrigin:r.origin];
	}
}

// AppKit 在显示、缩放、退出全屏、换焦点时重新布局标题栏会把按钮复位：这些通知后重摆（DidUpdate 兜底，位置对就跳过）。
// 本文件不开 ARC：块里不能捕获 w（块复制时会 retain 它，观察者又一直留在通知中心 → 每开一次对话窗口泄漏一个窗口和
// WKWebView），改用 note.object；窗口关闭时移除全部观察者
static void nomi_keep_traffic_lights(void *p, double x, double y) {
	NSWindow *w = (__bridge NSWindow *)p;
	nomi_place_traffic_lights(w, x, y);
	NSNotificationCenter *c = [NSNotificationCenter defaultCenter];
	NSOperationQueue *q = [NSOperationQueue mainQueue];
	NSMutableArray *tokens = [[NSMutableArray alloc] init];
	for (NSNotificationName n in @[ NSWindowDidResizeNotification, NSWindowDidExitFullScreenNotification,
	                               NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
	                               NSWindowDidUpdateNotification ]) {
		[tokens addObject:[c addObserverForName:n object:w queue:q usingBlock:^(NSNotification *note) {
			nomi_place_traffic_lights((NSWindow *)note.object, x, y);
		}]];
	}
	__block id closing = nil; // __block 在 MRC 下不 retain，避免块与观察者互相持有
	closing = [c addObserverForName:NSWindowWillCloseNotification object:w queue:q usingBlock:^(NSNotification *note) {
		for (id t in tokens) [c removeObserver:t];
		[tokens release];
		[c removeObserver:closing];
	}];
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// trafficLightX / Y = titleBarOptions('darwin').trafficLightPosition
const trafficLightX, trafficLightY = 14, 12

// placeTrafficLights：对话窗口（隐藏原生标题栏）的红绿灯放到 (14, 12)，与 Electron 相同
func placeTrafficLights(win *application.WebviewWindow) {
	application.InvokeAsync(func() {
		if p := win.NativeWindow(); p != nil {
			C.nomi_keep_traffic_lights(p, trafficLightX, trafficLightY)
		}
	})
}
