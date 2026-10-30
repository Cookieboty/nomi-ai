// Package viewpage：Go 宿主提供视图页面（packages/renderer、packages/ai-chat 的 index.html）时的改写。
// 视图与 Electron 共用同一份构建产物，宿主差异在这里补：
//   - CSP 的 connect-src 放行 ws://127.0.0.1:*（契约传输是连本机内核的 WebSocket；Electron 走 preload，构建产物里没有）；
//   - 插入 Wails 完整运行时 /wails/runtime.js（--wails-draggable 拖动窗口、文件拖放；Wails 加载完页面只注入核心桥）；
//   - 开发态再插入报错转发：页面的 console 与未捕获错误经 Wails 消息通道打到宿主日志（WebView 默认没有检查器）。
package viewpage

import (
	"bytes"
	"io/fs"
	"net/http"
	"strconv"
)

// RuntimeTag：Wails 完整运行时（BundledAssetFileServer 在 /wails/runtime.js 提供）
const RuntimeTag = `<script type="module" src="/wails/runtime.js"></script>`

// LogPrefix：开发态页面转给宿主的日志消息前缀（wailsshell 的 RawMessageHandler 打到日志）
const LogPrefix = "nomi:log:"

// ConnectSrc：Go 宿主额外放行的 connect-src
const ConnectSrc = "ws://127.0.0.1:*"

const consoleTag = `<script>(() => {
  const post = (m) => { try { (window.webkit && webkit.messageHandlers.external || window.chrome && chrome.webview).postMessage('` + LogPrefix + `' + m); } catch (e) {} };
  const str = (a) => a.map((x) => x instanceof Error ? (x.stack || x.message) : typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })() : String(x)).join(' ');
  for (const k of ['error', 'warn', 'info', 'log', 'debug']) { const f = console[k].bind(console); console[k] = (...a) => { post(k + ' ' + str(a)); f(...a); }; }
  addEventListener('error', (e) => post('uncaught ' + (e.error && e.error.stack || e.message) + (e.filename ? ' @' + e.filename + ':' + e.lineno : '')));
  addEventListener('unhandledrejection', (e) => post('unhandled ' + str([e.reason])));
})();</script>`

// Patch 改写视图页面；dev 时插入报错转发。已改写过的页面原样返回
func Patch(html []byte, dev bool) []byte {
	if bytes.Contains(html, []byte(RuntimeTag)) {
		return html
	}
	html = widenConnectSrc(html)
	i := bytes.Index(html, []byte("</head>"))
	if i < 0 {
		return html
	}
	var add []byte
	if dev {
		add = append(add, consoleTag...)
		add = append(add, '\n')
	}
	add = append(add, RuntimeTag...)
	add = append(add, '\n')
	out := make([]byte, 0, len(html)+len(add))
	out = append(out, html[:i]...)
	out = append(out, add...)
	return append(out, html[i:]...)
}

// widenConnectSrc：meta CSP 里 connect-src 指令末尾加上 ConnectSrc（没有 CSP 或没有 connect-src 时不动）
func widenConnectSrc(html []byte) []byte {
	m := bytes.Index(html, []byte(`http-equiv="Content-Security-Policy"`))
	if m < 0 {
		return html
	}
	c := bytes.Index(html[m:], []byte("connect-src"))
	if c < 0 {
		return html
	}
	start := m + c
	end := bytes.IndexAny(html[start:], `;"`)
	if end < 0 {
		return html
	}
	at := start + end
	out := make([]byte, 0, len(html)+len(ConnectSrc)+1)
	out = append(out, html[:at]...)
	out = append(out, ' ')
	out = append(out, ConnectSrc...)
	return append(out, html[at:]...)
}

// Middleware：pages 里的路径（如 /mascot/index.html，对应 assets 里去掉开头 / 的文件）改由这里读出、改写后返回，
// 其余请求交给 next（嵌入资产、网关、灵动岛页）
func Middleware(assets fs.FS, pages ...string) func(http.Handler) http.Handler {
	want := map[string]bool{}
	for _, p := range pages {
		want[p] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !want[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			raw, err := fs.ReadFile(assets, r.URL.Path[1:])
			if err != nil {
				next.ServeHTTP(w, r)
				return
			}
			body := Patch(raw, false)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			_, _ = w.Write(body)
		})
	}
}
