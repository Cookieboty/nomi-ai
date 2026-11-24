package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sessionHeaderTestConfig() *config.GatewayConfig {
	oc := u.NewObj(
		"id", "oc",
		"name", "OC",
		"enabled", true,
		"urls", u.NewObj("chat", "http://127.0.0.1:18903/oc/v1"),
		"keys", []any{u.NewObj("id", "k1", "value", "key-oc", "enabled", true)},
		"models", []any{u.NewObj("id", "m1", "enabled", true)},
		"quirks", u.NewObj("sessionHeader", "x-opencode-session"),
	)
	plain := u.NewObj(
		"id", "plain",
		"name", "Plain",
		"enabled", true,
		"urls", u.NewObj("chat", "http://127.0.0.1:18903/plain/v1"),
		"keys", []any{u.NewObj("id", "k2", "value", "key-plain", "enabled", true)},
		"models", []any{u.NewObj("id", "m2", "enabled", true)},
	)
	clients := u.NewObj("dsh", u.NewObj("token", "tok-dsh", "models", u.NewObj("main", "oc/m1")))
	root := u.NewObj(
		"host", "127.0.0.1",
		"port", 18722.0,
		"failoverEnabled", false,
		"providers", []any{oc, plain},
		"clients", clients,
		"allowedPrivateHosts", []any{"127.0.0.1:18903"},
	)
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(root)), &cfg); err != nil {
		panic(err)
	}
	return &cfg
}

// quirks.sessionHeader：同一个对话的请求带同一个会话 ID，不同对话不同；没声明的供应商不带。
func TestUpstreamSessionHeader(t *testing.T) {
	var mu sync.Mutex
	sessions := map[string][]string{}
	g := CreateGateway(sessionHeaderTestConfig(), GatewayHooks{
		FetchImpl: func(req *http.Request) (*http.Response, error) {
			// 网关按原样写头名（不经 Header.Set），这里大小写不敏感地取
			h := ""
			for k, vs := range req.Header {
				if strings.EqualFold(k, "x-opencode-session") && len(vs) > 0 {
					h = vs[0]
				}
			}
			mu.Lock()
			sessions[req.URL.Path] = append(sessions[req.URL.Path], h)
			mu.Unlock()
			reply := `{"id":"c1","object":"chat.completion","created":1,"model":"m1",` +
				`"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],` +
				`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(reply)),
				Request:    req,
			}, nil
		},
	})
	defer g.Stop()

	send := func(model, text string) *httptest.ResponseRecorder {
		body := `{"model":"` + model + `","messages":[{"role":"user","content":"` + text + `"}]}`
		req := httptest.NewRequest("POST", "http://127.0.0.1:18722/v1/chat/completions", bytes.NewReader([]byte(body)))
		req.Host = "127.0.0.1:18722"
		req.RequestURI = "/v1/chat/completions"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer tok-dsh")
		rec := httptest.NewRecorder()
		g.ServeHTTP(rec, req)
		return rec
	}

	for _, call := range []struct{ model, text string }{
		{"oc/m1", "hi"},
		{"oc/m1", "hi"},
		{"oc/m1", "another conversation"},
		{"plain/m2", "hi"},
	} {
		if rec := send(call.model, call.text); rec.Code != 200 {
			t.Fatalf("%s status=%d body=%s", call.model, rec.Code, rec.Body.String())
		}
	}

	mu.Lock()
	defer mu.Unlock()
	oc := sessions["/oc/v1/chat/completions"]
	if len(oc) != 3 {
		t.Fatalf("oc calls=%d", len(oc))
	}
	for i, v := range oc {
		if v == "" {
			t.Fatalf("call %d missing x-opencode-session", i+1)
		}
	}
	if oc[0] != oc[1] {
		t.Fatalf("same conversation should keep one session: %q vs %q", oc[0], oc[1])
	}
	if oc[0] == oc[2] {
		t.Fatalf("different conversations should get different sessions: %q", oc[0])
	}
	plain := sessions["/plain/v1/chat/completions"]
	if len(plain) != 1 || plain[0] != "" {
		t.Fatalf("plain provider must not get the session header: %v", plain)
	}
}
