package shell

import (
	"net/http"
	"strings"
)

// 浏览器标签的窗口跑的是**任意外部网页**（顶层文档）。在 Windows / Linux 上它们是普通 Wails 窗口，
// 和应用自己的页面共用一套宿主通道，所以必须在宿主侧按窗口名把它们挡在外面：
//   - RawMessageHandler：外部网页的 chrome.webview.postMessage / webkit messageHandlers 是主框架消息，
//     不能进 OnPageMessage（nomi:open-external、nomi:clipboard-files、nomi:island:* 等）；
//   - 资产服务器：外部网页能对 http://wails.localhost/* 发请求（Wails 按 WebView 拦截、并替它盖上
//     x-wails-window-name），包括 /wails/runtime（运行时调用、绑定服务）与应用页面，一律拒绝。
// macOS 的浏览器标签是不挂任何消息处理器 / 自定义 scheme 的纯 WKWebView，本来就够不到这些。

// BrowserWindowPrefix：浏览器标签窗口名前缀（wailsshell.browserName 生成）。
const BrowserWindowPrefix = "browser-"

// wailsWindowNameHeader：Wails 给每个资产请求盖上的来源窗口名（application.webViewRequestHeaderWindowName）。
// 由宿主按发起请求的 WebView 设置并覆盖页面自带的同名头，页面伪造不了。
const wailsWindowNameHeader = "x-wails-window-name"

// IsBrowserWindow：窗口名是不是浏览器标签的窗口。
func IsBrowserWindow(name string) bool { return strings.HasPrefix(name, BrowserWindowPrefix) }

// AcceptPageMessage：这条页面消息能不能交给宿主处理。
// 浏览器标签窗口的一律拒（含主框架）；其它窗口只收顶层文档的（内嵌 iframe 不能伪造 nomi:* 信号）。
func AcceptPageMessage(windowName string, mainFrame bool) bool {
	return mainFrame && !IsBrowserWindow(windowName)
}

// GuardBrowserWindowAssets：资产服务器最外层中间件，浏览器标签窗口发来的请求一律 403。
func GuardBrowserWindowAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IsBrowserWindow(r.Header.Get(wailsWindowNameHeader)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
