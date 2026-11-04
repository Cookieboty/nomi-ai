package gateway_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 同 Node context1m.test.ts：按已知 Claude 模型处理的 1M 模型补 context-1m；上游拒绝就去掉重试，
// 之后的请求直接不带
func TestContext1mBetaRetry(t *testing.T) {
	o := u.NewObj("host", "127.0.0.1", "port", 0.0,
		"providers", []any{u.NewObj("id", "maas", "name", "MAAS", "enabled", true,
			"urls", u.NewObj("messages", "https://relay.example.test"),
			"keys", []any{u.NewObj("id", "k1", "value", "sk-test-1", "enabled", true)},
			"models", []any{u.NewObj("id", "Aerith-opus-5.5", "enabled", true, "like", "claude-opus-4-8")})},
		"clients", u.NewObj("claude", u.NewObj("token", "tok-claude", "models", u.NewObj("main", "maas/Aerith-opus-5.5"))))
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(o)), &cfg); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var seen []string
	reply := `{"id":"m1","type":"message","role":"assistant","model":"Aerith-opus-5.5",` +
		`"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}`
	g := server.CreateGateway(&cfg, server.GatewayHooks{
		FetchImpl: func(req *http.Request) (*http.Response, error) {
			_, _ = io.ReadAll(req.Body)
			// 网关按原样的小写名设头（与 Node 一致），不用 Header.Get（它会规范化成 Anthropic-Beta）
			beta := ""
			if v := req.Header["anthropic-beta"]; len(v) > 0 {
				beta = v[0]
			}
			mu.Lock()
			seen = append(seen, beta)
			mu.Unlock()
			status, body := 200, reply
			if strings.Contains(beta, "context-1m") {
				status, body = 400, `{"error":{"message":"unsupported anthropic-beta: context-1m"}}`
			}
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}},
				Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
		},
	})
	if err := g.Start(); err != nil {
		t.Fatal(err)
	}
	defer g.Stop()
	hc := &http.Client{Timeout: 30 * time.Second}
	send := func() int {
		body := `{"model":"maas/Aerith-opus-5.5","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}`
		req, _ := http.NewRequest("POST", g.ListenURL()+"/v1/messages", bytes.NewReader([]byte(body)))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-api-key", "tok-claude")
		res, err := hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.ReadAll(res.Body)
		res.Body.Close()
		return res.StatusCode
	}
	if s := send(); s != 200 {
		t.Fatalf("first status %d", s)
	}
	mu.Lock()
	first := append([]string{}, seen...)
	mu.Unlock()
	if len(first) != 2 || first[0] != route.Context1mBeta || first[1] != "" {
		t.Fatalf("first request upstream betas %q", first)
	}
	if s := send(); s != 200 {
		t.Fatalf("second status %d", s)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 3 || seen[2] != "" {
		t.Fatalf("second request should not carry the beta: %q", seen)
	}
}
