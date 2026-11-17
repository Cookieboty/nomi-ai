// 内置浏览器的 macOS 载体：WKWebView 作为对话窗口 contentView 的子视图。
//
// 本文件不开 ARC（与包内其它 Objective-C 写法一致），引用计数手写：
// create 里的 alloc 是「我们这一份」，subview 另有一份；close 时先移出父视图再 release。

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#include "_cgo_export.h"

// 导航事件回传给 Go（Go 侧按 handle 找到对应的 browser）
@interface NomiBrowserDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic, assign) int handle;
@end

@implementation NomiBrowserDelegate

- (void)reportFinished:(BOOL)ok error:(NSError *)error {
	const char *message = NULL;
	if (!ok && error != nil) message = [[error localizedDescription] UTF8String];
	nomiBrowserDidLoad(self.handle, ok ? 1 : 0, (char *)message);
}

- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
	[self reportFinished:YES error:nil];
}

- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
	[self reportFinished:NO error:error];
}

- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
	[self reportFinished:NO error:error];
}

// target=_blank / window.open：在当前视图里导航，不弹新窗口（弹出来就没法嵌回来了）
- (WKWebView *)webView:(WKWebView *)view
	createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
			   forNavigationAction:(WKNavigationAction *)action
					windowFeatures:(WKWindowFeatures *)features {
	NSURL *target = action.request.URL;
	if (target != nil) [view loadRequest:[NSURLRequest requestWithURL:target]];
	return nil;
}

@end

static char nomiDelegateKey;

void *nomiBrowserCreate(void *nsWindow, int handle, double x, double y, double w, double h, const char *url) {
	NSWindow *window = (__bridge NSWindow *)nsWindow;
	NSView *content = [window contentView];
	if (content == nil) return NULL;

	WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
	// 和普通浏览器一样共享同一份 cookie / 站点数据（登录态能留住）
	config.websiteDataStore = [WKWebsiteDataStore defaultDataStore];

	NomiBrowserDelegate *delegate = [[NomiBrowserDelegate alloc] init];
	delegate.handle = handle;

	WKWebView *view = [[WKWebView alloc] initWithFrame:NSMakeRect(x, y, w, h) configuration:config];
	[config release];

	// navigationDelegate 是弱引用，delegate 由关联对象持有，跟着 view 一起释放
	view.navigationDelegate = delegate;
	objc_setAssociatedObject(view, &nomiDelegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
	[delegate release];

	// 位置由我们自己摆（区域来自视图），不跟着 superview 尺寸走
	view.autoresizingMask = NSViewNotSizable;
	// 先藏着：等首次加载完成（或超时）再亮，避免白底闪一下
	[view setHidden:YES];
	[content addSubview:view positioned:NSWindowAbove relativeTo:nil];

	if (url != NULL) {
		NSString *text = [NSString stringWithUTF8String:url];
		NSURL *target = text != nil ? [NSURL URLWithString:text] : nil;
		if (target != nil) [view loadRequest:[NSURLRequest requestWithURL:target]];
	}
	return (void *)view;
}

void nomiBrowserSetRegion(void *handle, double x, double y, double w, double h) {
	WKWebView *view = (WKWebView *)handle;
	if (view == nil) return;
	[view setFrame:NSMakeRect(x, y, w, h)];
}

void nomiBrowserSetHidden(void *handle, int hidden) {
	WKWebView *view = (WKWebView *)handle;
	if (view == nil) return;
	[view setHidden:hidden != 0];
}

void nomiBrowserLoad(void *handle, const char *url) {
	WKWebView *view = (WKWebView *)handle;
	if (view == nil || url == NULL) return;
	NSString *text = [NSString stringWithUTF8String:url];
	NSURL *target = text != nil ? [NSURL URLWithString:text] : nil;
	if (target != nil) [view loadRequest:[NSURLRequest requestWithURL:target]];
}

void nomiBrowserReload(void *handle) {
	WKWebView *view = (WKWebView *)handle;
	if (view == nil) return;
	[view reload];
}

void nomiBrowserClose(void *handle) {
	WKWebView *view = (WKWebView *)handle;
	if (view == nil) return;
	[view stopLoading];
	view.navigationDelegate = nil;
	objc_setAssociatedObject(view, &nomiDelegateKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
	[view removeFromSuperview];
	[view release];
}

// 内容区高度：区域坐标（左上原点）转 NSView 坐标（左下原点）要用
double nomiBrowserContentHeight(void *nsWindow) {
	NSWindow *window = (__bridge NSWindow *)nsWindow;
	NSView *content = [window contentView];
	if (content == nil) return 0;
	return NSHeight([content frame]);
}
