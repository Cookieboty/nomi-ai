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

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func failoverTestConfig(failoverEnabled bool) *config.GatewayConfig {
	pa := u.NewObj(
		"id", "pa",
		"name", "PA",
		"enabled", true,
		"urls", u.NewObj("chat", "http://127.0.0.1:18901/a/v1"),
		"keys", []any{u.NewObj("id", "ka", "value", "key-a", "enabled", true)},
		"models", []any{u.NewObj("id", "m1", "enabled", true)},
	)
	pb := u.NewObj(
		"id", "pb",
		"name", "PB",
		"enabled", true,
		"urls", u.NewObj("chat", "http://127.0.0.1:18901/b/v1"),
		"keys", []any{u.NewObj("id", "kb", "value", "key-b", "enabled", true)},
		"models", []any{u.NewObj("id", "m1", "enabled", true)},
	)
	clients := u.NewObj("dsh", u.NewObj("token", "tok-dsh", "models", u.NewObj("main", "pa/m1")))
	root := u.NewObj(
		"host", "127.0.0.1",
		"port", 18721.0,
		"failoverEnabled", failoverEnabled,
		"providers", []any{pa, pb},
		"clients", clients,
		"allowedPrivateHosts", []any{"127.0.0.1:18901"},
	)
	var cfg config.GatewayConfig
	if err := json.Unmarshal([]byte(u.Stringify(root)), &cfg); err != nil {
		panic(err)
	}
	return &cfg
}

func TestFailoverEnabledGatesCooldownDemotionAndFailover(t *testing.T) {
	retryBase := 0.0
	var mu sync.Mutex
	hits := map[string]int{}

	g := CreateGateway(failoverTestConfig(false), GatewayHooks{
		TimeoutHooks: upstream.TimeoutHooks{RetryBaseDelayMs: &retryBase},
		FetchImpl: func(req *http.Request) (*http.Response, error) {
			path := req.URL.Path
			mu.Lock()
			switch {
			case strings.HasPrefix(path, "/a/"):
				hits["pa"]++
				mu.Unlock()
				return &http.Response{
					StatusCode: 503,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"pa down"}}`)),
					Request:    req,
				}, nil
			case strings.HasPrefix(path, "/b/"):
				hits["pb"]++
				mu.Unlock()
				reply := `{"id":"c1","object":"chat.completion","created":1,"model":"m1",` +
					`"choices":[{"index":0,"message":{"role":"assistant","content":"from-pb"},"finish_reason":"stop"}],` +
					`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`
				return &http.Response{
					StatusCode: 200,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(reply)),
					Request:    req,
				}, nil
			default:
				mu.Unlock()
				return nil, http.ErrHandlerTimeout
			}
		},
	})
	defer g.Stop()

	send := func() *httptest.ResponseRecorder {
		body := `{"model":"pa/m1","messages":[{"role":"user","content":"hi"}]}`
		req := httptest.NewRequest("POST", "http://127.0.0.1:18721/v1/chat/completions", bytes.NewReader([]byte(body)))
		req.Host = "127.0.0.1:18721"
		req.RequestURI = "/v1/chat/completions"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer tok-dsh")
		rec := httptest.NewRecorder()
		g.ServeHTTP(rec, req)
		return rec
	}

	// 1. 默认关闭熔断降级：pa 返回 503 时只会在 pa 上重连，绝不切换到 pb，也不会写入冷却熔断
	rec1 := send()
	if rec1.Code != 503 {
		t.Fatalf("expected 503 when failover disabled, got %d body=%s", rec1.Code, rec1.Body.String())
	}
	mu.Lock()
	pbBefore := hits["pb"]
	paBefore := hits["pa"]
	mu.Unlock()
	if paBefore == 0 || pbBefore != 0 {
		t.Fatalf("expected only pa called when failover off, got pa=%d pb=%d", paBefore, pbBefore)
	}
	candA := &cand.Candidate{Provider: &g.Config().Providers[0], Key: &g.Config().Providers[0].Keys[0], Wire: "chat"}
	candB := &cand.Candidate{Provider: &g.Config().Providers[1], Key: &g.Config().Providers[1].Keys[0], Wire: "chat"}
	if g.cool.IsCooling(candA) {
		t.Fatal("expected pa not cooled when failover is disabled")
	}

	// 即便 Metrics 记下劣质样本，ordered 在 FailoverEnabled=false 时也不做降级重排
	for i := 0; i < AdaptiveMinSamples; i++ {
		g.Metrics.RecordHealth(HealthSample{Provider: "pa", KeyID: "ka", Wire: "chat", OK: false, AuthLimited: true})
	}
	ordOff := g.ordered(g.Config(), []*cand.Candidate{candA, candB}, nil)
	if ordOff[0].Provider.ID != "pa" {
		t.Fatalf("expected pa first when failover off, got %s", ordOff[0].Provider.ID)
	}

	// 2. 开启熔断降级后：ordered 识别降级/冷却；请求 pa 失败后自动冷却并故障转移到 pb
	g.Update(failoverTestConfig(true))
	ordOn := g.ordered(g.Config(), []*cand.Candidate{candA, candB}, nil)
	if ordOn[0].Provider.ID != "pb" {
		t.Fatalf("expected demoted pa moved after pb when failover on, got %s", ordOn[0].Provider.ID)
	}

	mu.Lock()
	hits["pa"] = 0
	hits["pb"] = 0
	mu.Unlock()
	rec2 := send()
	if rec2.Code != 200 || !strings.Contains(rec2.Body.String(), "from-pb") {
		t.Fatalf("expected failover to pb returning 200, got status=%d body=%s", rec2.Code, rec2.Body.String())
	}
	mu.Lock()
	pbAfter := hits["pb"]
	mu.Unlock()
	if pbAfter != 1 {
		t.Fatalf("expected pb hit once on failover, got %d", pbAfter)
	}
}
