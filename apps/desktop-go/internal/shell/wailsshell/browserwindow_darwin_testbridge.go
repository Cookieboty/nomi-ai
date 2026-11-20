//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <string.h>
#include <stdlib.h>

extern void *nomiBrowserCreate(void *nsWindow, int handle, double x, double y, double w, double h, const char *url);
extern void nomiBrowserLoad(void *view, const char *url);
extern void nomiBrowserSetHidden(void *view, int hidden);
extern void nomiBrowserClose(void *view);
extern int nomiBrowserURLAllowed(const char *raw);

@interface NomiTestNavAction : WKNavigationAction
@property(nonatomic, copy) NSURLRequest *testRequest;
@property(nonatomic, retain) WKFrameInfo *testTargetFrame;
@end

@implementation NomiTestNavAction
- (NSURLRequest *)request { return _testRequest; }
- (WKFrameInfo *)targetFrame { return _testTargetFrame; }
- (void)dealloc {
	[_testRequest release];
	[_testTargetFrame release];
	[super dealloc];
}
@end

static void nomiBridgeInitApp(void) {
	NSApplication *app = [NSApplication sharedApplication];
	[app setActivationPolicy:NSApplicationActivationPolicyRegular];
	[app finishLaunching];
}

static void nomiBridgePumpRunLoop(double seconds) {
	NSAutoreleasePool *pool = [[NSAutoreleasePool alloc] init];
	NSDate *until = [NSDate dateWithTimeIntervalSinceNow:seconds];
	[[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:until];
	[pool release];
}

static void *nomiBridgeNewWindow(void) {
	NSWindow *win = [[NSWindow alloc]
		initWithContentRect:NSMakeRect(0, 0, 800, 600)
				  styleMask:NSWindowStyleMaskTitled
					backing:NSBackingStoreBuffered
					  defer:NO];
	[win orderOut:nil];
	return (void *)win;
}

static void nomiBridgeCloseWindow(void *w) {
	NSWindow *win = (NSWindow *)w;
	if (win != nil) [win close];
}

// 测试里要把窗口和子视图亮出来：生产路径会在首次加载完成后 Show()。
// 一直 orderOut + hidden 时，macOS 15 上 WKWebView 的 JS 执行 / 同源链接点击不会跑起来。
static void nomiBridgeRevealWindow(void *w) {
	NSWindow *win = (NSWindow *)w;
	if (win == nil) return;
	[win makeKeyAndOrderFront:nil];
}

static int nomiBridgeDelegatesBound(void *v) {
	WKWebView *view = (WKWebView *)v;
	if (view == nil) return 0;
	if (view.navigationDelegate == nil || view.UIDelegate == nil) return 0;
	if ((id)view.UIDelegate != (id)view.navigationDelegate) return 0;
	if (![view.UIDelegate conformsToProtocol:@protocol(WKUIDelegate)]) return 0;
	if (![view.UIDelegate conformsToProtocol:@protocol(WKNavigationDelegate)]) return 0;
	if (view.configuration.preferences.javaScriptCanOpenWindowsAutomatically) return 0;
	return 1;
}

static int nomiBridgeDelegatesCleared(void *v) {
	WKWebView *view = (WKWebView *)v;
	if (view == nil) return 0;
	return (view.navigationDelegate == nil && view.UIDelegate == nil) ? 1 : 0;
}

static void nomiBridgeRetainView(void *v) {
	if (v != NULL) [(id)v retain];
}

static void nomiBridgeReleaseView(void *v) {
	if (v != NULL) [(id)v release];
}

static const char *nomiBridgeWebViewURL(void *v) {
	static char buf[8192];
	buf[0] = '\0';
	WKWebView *view = (WKWebView *)v;
	if (view == nil || view.URL == nil) return buf;
	const char *raw = [view.URL.absoluteString UTF8String];
	if (raw != NULL) {
		strncpy(buf, raw, sizeof(buf) - 1);
		buf[sizeof(buf) - 1] = '\0';
	}
	return buf;
}

static void nomiBridgeClickPoint(void *w, void *v, double x, double y) {
	NSWindow *win = (NSWindow *)w;
	WKWebView *view = (WKWebView *)v;
	NSPoint viewPt = NSMakePoint(x, NSHeight([view bounds]) - y);
	NSPoint winPt = [view convertPoint:viewPt toView:nil];
	NSEvent *down = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
									   location:winPt
								  modifierFlags:0
									  timestamp:[[NSProcessInfo processInfo] systemUptime]
								   windowNumber:[win windowNumber]
										context:nil
									eventNumber:1
									 clickCount:1
									   pressure:1.0];
	NSEvent *up = [NSEvent mouseEventWithType:NSEventTypeLeftMouseUp
									 location:winPt
								modifierFlags:0
									timestamp:[[NSProcessInfo processInfo] systemUptime]
								 windowNumber:[win windowNumber]
									  context:nil
								  eventNumber:2
								   clickCount:1
									 pressure:0.0];
	[win sendEvent:down];
	[win sendEvent:up];
}

// 同步执行 JS，返回错误信息（堆上，调用方 free）；成功返回 NULL。
static char *nomiBridgeEvalJS(void *v, const char *js) {
	WKWebView *view = (WKWebView *)v;
	if (view == nil) return strdup("nil webview");
	NSString *code = [NSString stringWithUTF8String:js];
	__block char *result = NULL;
	__block BOOL done = NO;
	[view evaluateJavaScript:code completionHandler:^(id val, NSError *err) {
		if (err != nil) {
			const char *msg = [[err localizedDescription] UTF8String];
			result = strdup(msg != NULL ? msg : "evaluateJavaScript failed");
		}
		done = YES;
	}];
	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5.0];
	while (!done && [deadline timeIntervalSinceNow] > 0) {
		NSAutoreleasePool *pool = [[NSAutoreleasePool alloc] init];
		[[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
		[pool release];
	}
	if (!done) return strdup("evaluateJavaScript timed out");
	return result;
}

static int nomiBridgeInvokeCreateWebView(void *v, const char *rawURL) {
	WKWebView *view = (WKWebView *)v;
	NSURL *url = rawURL != NULL ? [NSURL URLWithString:[NSString stringWithUTF8String:rawURL]] : nil;
	NomiTestNavAction *action = [[NomiTestNavAction alloc] init];
	action.testRequest = url != nil ? [NSURLRequest requestWithURL:url] : nil;
	action.testTargetFrame = nil;
	WKWebView *ret = [view.UIDelegate webView:view
				createWebViewWithConfiguration:view.configuration
						   forNavigationAction:action
								windowFeatures:[[[WKWindowFeatures alloc] init] autorelease]];
	[action release];
	return ret == nil ? 1 : 0;
}
*/
import "C"

import "unsafe"

func darwinURLAllowedForTest(raw string) bool {
	cstr := C.CString(raw)
	defer C.free(unsafe.Pointer(cstr))
	return C.nomiBrowserURLAllowed(cstr) == 1
}

func darwinInitAppForTest() {
	C.nomiBridgeInitApp()
}

func darwinPumpRunLoopForTest(seconds float64) {
	C.nomiBridgePumpRunLoop(C.double(seconds))
}

func darwinNewWindowForTest() unsafe.Pointer {
	return C.nomiBridgeNewWindow()
}

func darwinCloseWindowForTest(win unsafe.Pointer) {
	C.nomiBridgeCloseWindow(win)
}

func darwinCreateBrowserForTest(win unsafe.Pointer, handle int32, url string) unsafe.Pointer {
	cstr := C.CString(url)
	defer C.free(unsafe.Pointer(cstr))
	view := C.nomiBrowserCreate(win, C.int(handle), 0, 0, 800, 600, cstr)
	if view != nil {
		C.nomiBridgeRetainView(view)
	}
	return view
}

func darwinLoadBrowserForTest(view unsafe.Pointer, url string) {
	cstr := C.CString(url)
	defer C.free(unsafe.Pointer(cstr))
	C.nomiBrowserLoad(view, cstr)
}

func darwinCloseBrowserForTest(view unsafe.Pointer) (delegatesCleared bool) {
	C.nomiBrowserClose(view)
	cleared := C.nomiBridgeDelegatesCleared(view) == 1
	C.nomiBridgeReleaseView(view)
	return cleared
}

func darwinDelegatesBoundForTest(view unsafe.Pointer) bool {
	return C.nomiBridgeDelegatesBound(view) == 1
}

func darwinWebViewURLForTest(view unsafe.Pointer) string {
	return C.GoString(C.nomiBridgeWebViewURL(view))
}

func darwinClickPointForTest(win, view unsafe.Pointer, x, y float64) {
	C.nomiBridgeClickPoint(win, view, C.double(x), C.double(y))
}

func darwinRevealBrowserForTest(win, view unsafe.Pointer) {
	C.nomiBrowserSetHidden(view, 0)
	C.nomiBridgeRevealWindow(win)
}

func darwinEvalJSForTest(view unsafe.Pointer, js string) string {
	cstr := C.CString(js)
	defer C.free(unsafe.Pointer(cstr))
	err := C.nomiBridgeEvalJS(view, cstr)
	if err == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(err))
	return C.GoString(err)
}

func darwinInvokeCreateWebViewForTest(view unsafe.Pointer, rawURL string) bool {
	cstr := C.CString(rawURL)
	defer C.free(unsafe.Pointer(cstr))
	return C.nomiBridgeInvokeCreateWebView(view, cstr) == 1
}
