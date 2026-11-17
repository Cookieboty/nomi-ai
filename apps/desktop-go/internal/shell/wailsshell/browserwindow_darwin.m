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

// 键盘焦点还给对话页面。
//
// 网页子视图拿走键盘焦点之后（用户在里面打过字、点过输入框），藏掉 / 关掉它时 AppKit 把第一响应者
// 交给「下一个可接受焦点的视图」或窗口本身，不会交回对话页面的 WKWebView：对话页面上光标看着还在
// 输入框里，键盘消息却进不去。
//
// 只在第一响应者是这个浏览器子视图（或它里面的内容视图）时才动，对话页面自己的焦点一点不碰。
// 对话页面是 contentView 下面那个不是浏览器子视图的 WKWebView（Wails 把它加在 contentView 里；
// 我们的浏览器子视图也是 WKWebView，靠 nomiDelegateKey 关联对象区分）。contentView 本身是普通
// NSView、不接受第一响应者，不能交给它。找不到对话页面时退回 makeFirstResponder:nil（交给窗口）。
// 只读视图层级、不持有任何对象，不涉及引用计数。
static WKWebView *nomi_chat_webview(NSView *content) {
	for (NSView *sub in [content subviews]) {
		if (![sub isKindOfClass:[WKWebView class]]) continue;
		if (objc_getAssociatedObject(sub, &nomiDelegateKey) != nil) continue;
		return (WKWebView *)sub;
	}
	return nil;
}

static void nomi_release_focus(WKWebView *view) {
	NSWindow *window = [view window];
	if (window == nil) return;
	NSView *content = [window contentView];
	if (content == nil) return;
	id responder = [window firstResponder];
	if (![responder isKindOfClass:[NSView class]]) return;
	if (![(NSView *)responder isDescendantOf:view]) return;
	WKWebView *chat = nomi_chat_webview(content);
	if (chat == nil || ![window makeFirstResponder:chat]) [window makeFirstResponder:nil];
}

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
	// 焦点要在藏之前处理：藏起来时 AppKit 已经把第一响应者挪走，就看不出它原来在浏览器里
	if (hidden != 0) nomi_release_focus(view);
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
	// 同上：移出父视图之前，把焦点还给对话页面
	nomi_release_focus(view);
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
