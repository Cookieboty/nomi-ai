package gateway_test

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const concurrentChatReply = `{"id":"c1","object":"chat.completion","created":1,"model":"m1",` +
	`"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],` +
	`"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`

// #199 / #201：多个连接同时打同一个网关（不同标签、不同 session），proxy 并发读写 Affinity，
// 外发脱敏并发写同一个 SecretStore，期间还有配置更新 Configure。上游用 FetchImpl 模拟，
// 不连真实模型；样本都是合成值。配合 `go test -race` 守住无竞态、不崩溃、密钥不外发。
func TestGatewayConcurrentAffinityAndPrivacy(t *testing.T) {
	// 非回环地址才算外部目标，脱敏才会生效；FetchImpl 接管请求，不会真的解析这个域名。
	cfgFor := func(gen int) *u.Obj {
		return u.NewObj("privacy", u.NewObj("enabled", true, "key", "race-key", "known", []any{
			u.NewObj("kind", "SECRET", "value", "nomi_review_dummy_alpha"),
			u.NewObj("kind", "SECRET", "value", "nomi_review_dummy_beta"),
			u.NewObj("kind", "SECRET", "value", fmt.Sprintf("nomi_review_dummy_gen_%04d", gen)),
		}))
	}
	var mu sync.Mutex
	var sent []string
	g := server.CreateGateway(e2eConfig("api.example.test", cfgFor(0)), server.GatewayHooks{
		FetchImpl: func(req *http.Request) (*http.Response, error) {
			b, _ := io.ReadAll(req.Body)
			mu.Lock()
			sent = append(sent, string(b))
			mu.Unlock()
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(strings.NewReader(concurrentChatReply)),
				Request:    req,
			}, nil
		},
	})
	if err := g.Start(); err != nil {
		t.Fatal(err)
	}
	defer g.Stop()

	hc := &http.Client{Timeout: 30 * time.Second}
	const workers, rounds = 12, 15
	var wg sync.WaitGroup
	stop := make(chan struct{})
	// 配置更新与在途请求并发：Update → privacy.Configure。
	go func() {
		for i := 1; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			g.Update(e2eConfig("api.example.test", cfgFor(i)))
			time.Sleep(time.Millisecond)
		}
	}()
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				text := fmt.Sprintf("tab %d round %d nomi_review_dummy_alpha and nomi_review_dummy_beta", w, i)
				body := u.Stringify(u.NewObj("model", "pc/m1", "messages", []any{u.NewObj("role", "user", "content", text)}))
				req, _ := http.NewRequest("POST", g.ListenURL()+"/v1/chat/completions", bytes.NewReader([]byte(body)))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer tok-dsh")
				// 一半共用一个 session，一半各自的 session：同 / 不同 key 都并发打到 Affinity。
				tab := "shared"
				if w%2 == 1 {
					tab = fmt.Sprintf("tab-%d", w)
				}
				req.Header.Set("x-nomi-tab", tab)
				resp, err := hc.Do(req)
				if err != nil {
					t.Errorf("worker %d: %v", w, err)
					return
				}
				rb, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				if resp.StatusCode != 200 {
					t.Errorf("worker %d: status %d %s", w, resp.StatusCode, rb)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(stop)

	mu.Lock()
	defer mu.Unlock()
	if len(sent) != workers*rounds {
		t.Fatalf("upstream got %d requests, want %d", len(sent), workers*rounds)
	}
	for _, b := range sent {
		if strings.Contains(b, "nomi_review_dummy_alpha") || strings.Contains(b, "nomi_review_dummy_beta") {
			t.Fatalf("known secret sent upstream: %s", b)
		}
	}
}
