//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// 非激活浮窗（桌面角色、灵动岛）不是活动窗口时，macOS 默认把第一下点击只用来激活窗口，
// 不交给网页：WKWebView 只有点在链接 / 图片这类可拖的元素上才接 first mouse。于是按住角色拖不动、
// 点灵动岛通知需要点两次才触发 click。这里让打了标记的非激活浮窗里的 WKWebView 接收第一下点击；
// 其它窗口（如对话窗口）走原来的判断，不受影响。
static char nomiFirstMouseKey;
static BOOL (*nomiOrigAcceptsFirstMouse)(id, SEL, NSEvent *);

static BOOL nomi_accepts_first_mouse(id self, SEL _cmd, NSEvent *event) {
	NSWindow *w = [(NSView *)self window];
	if (w && objc_getAssociatedObject(w, &nomiFirstMouseKey)) return YES;
	return nomiOrigAcceptsFirstMouse ? nomiOrigAcceptsFirstMouse(self, _cmd, event) : NO;
}

static void nomi_install_first_mouse(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		Class c = [WKWebView class];
		SEL sel = @selector(acceptsFirstMouse:);
		Method m = class_getInstanceMethod(c, sel);
		if (!m) return;
		// class_replaceMethod 只换 WKWebView 自己这一层（没有自己的实现时是新加，原实现取父类的）
		IMP prev = class_replaceMethod(c, sel, (IMP)nomi_accepts_first_mouse, method_getTypeEncoding(m));
		nomiOrigAcceptsFirstMouse = (BOOL (*)(id, SEL, NSEvent *))(prev ? prev : method_getImplementation(m));
	});
}

static void nomi_accept_first_mouse(void *p) {
	NSWindow *w = (__bridge NSWindow *)p;
	nomi_install_first_mouse();
	objc_setAssociatedObject(w, &nomiFirstMouseKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// acceptFirstMouse：非激活浮窗（桌面角色 / 灵动岛）不是活动窗口时，第一下点击也直接交给网页
func acceptFirstMouse(win *application.WebviewWindow) {
	application.InvokeAsync(func() {
		if p := win.NativeWindow(); p != nil {
			C.nomi_accept_first_mouse(p)
		}
	})
}
