package assetproto

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// 网关往返：对 golden 中每个能构成 Request 的地址，GatewayURL → HTTP 请求 → RawURLFromGateway
// 还原后再解析，scheme / hostname / pathname 与直接解析一致（网关不改变处理体看到的语义）
func TestGatewayRoundTrip(t *testing.T) {
	raw, _ := os.ReadFile("testdata/protocols.json")
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	for _, c := range append(g.Chat, g.Pack...) {
		if c.Response.Request == "invalid" {
			continue
		}
		u0, ok := parseURL(c.URL)
		if !ok || (u0.Protocol != "chat-asset:" && u0.Protocol != "character-pack:") || u0.Hostname == "" {
			continue
		}
		// Chromium 交给 handler 的 req.url 已规范化（不含片段）；网关同样看不到片段
		canon := u0.Protocol + "//" + u0.Hostname + u0.Pathname
		if _, ok := decodeURIComponent(u0.Pathname); !ok {
			continue // 非法 % 序列：Go HTTP 服务器先回 400（Electron 为 404），见 D-B10-5
		}
		req := httptest.NewRequest(http.MethodGet, "http://wails.localhost"+GatewayURL(canon), nil)
		_, back, ok := RawURLFromGateway(req)
		if !ok {
			t.Fatalf("%q not gateway", c.URL)
		}
		u1, _ := parseURL(back)
		d0, _ := decodeURIComponent(u0.Pathname)
		d1, _ := decodeURIComponent(u1.Pathname)
		if u1.Protocol != u0.Protocol || u1.Hostname != u0.Hostname || d1 != d0 {
			t.Errorf("%q: gateway %+v direct %+v", c.URL, u1, u0)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "http://wails.localhost/index.html", nil)
	if _, _, ok := RawURLFromGateway(req); ok {
		t.Fatal("non-gateway matched")
	}
	rec := httptest.NewRecorder()
	called := ""
	Middleware(map[string]func(http.ResponseWriter, string){"chat-asset": func(w http.ResponseWriter, u string) { called = u }})(nil).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://wails.localhost/__scheme/chat-asset/presets/background.jpg", nil))
	if called != ChatBgPresetURL {
		t.Fatalf("preset via gateway = %q", called)
	}
}
