package assetproto

import (
	"net/http"
	"strings"
)

// GatewayPrefix：Wails v3.0.0 只把自家 "wails" scheme 交给 Go（mac 的 setURLSchemeHandler、
// Linux 的 webkit_web_context_register_uri_scheme 都硬编码在框架里，WebView2 的自定义 scheme
// 需在建 Environment 时注册），无法像 Electron protocol.handle 那样注册任意 scheme。
// 因此在资产服务器上开一个网关：<origin>/__scheme/<scheme>/<host>/<path>?<query>
// 还原为 <scheme>://<host>/<path>?<query> 后交给与 Electron 逐字对应的处理体（见 D-B10-5）。
const GatewayPrefix = "/__scheme/"

// RawURLFromGateway：网关路径 → 原始协议地址；ok=false 表示不是网关请求
func RawURLFromGateway(r *http.Request) (scheme, raw string, ok bool) {
	p := r.URL.EscapedPath()
	if !strings.HasPrefix(p, GatewayPrefix) {
		return "", "", false
	}
	rest := p[len(GatewayPrefix):]
	i := strings.IndexByte(rest, '/')
	if i <= 0 {
		return "", "", false
	}
	scheme, raw = rest[:i], rest[:i]+"://"+rest[i+1:]
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		raw += "?" + r.URL.RawQuery
	}
	return scheme, raw, true
}

// GatewayURL：前端用；<scheme>://rest → /__scheme/<scheme>/rest（与 RawURLFromGateway 互逆）
func GatewayURL(raw string) string {
	i := strings.Index(raw, "://")
	if i <= 0 {
		return raw
	}
	// \ 在 http(s) 地址里会被浏览器当分隔符；编码后解码结果与原地址一致
	return GatewayPrefix + raw[:i] + "/" + strings.ReplaceAll(raw[i+3:], `\`, "%5C")
}

// Middleware：把网关请求分发给 handlers[scheme]；未知 scheme 404（与未注册协议一致），其余放行
func Middleware(handlers map[string]func(w http.ResponseWriter, rawURL string)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			scheme, raw, ok := RawURLFromGateway(r)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			h := handlers[scheme]
			if h == nil {
				http.NotFound(w, r)
				return
			}
			h(w, raw)
		})
	}
}
