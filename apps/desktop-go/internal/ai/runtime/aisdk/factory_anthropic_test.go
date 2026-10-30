package aisdk

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/anthropic"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 生产工厂 protocol=anthropic 的接线测试（#187）：NewProvider(opts, nil) → BuildModelFactory →
// Anthropic Messages 适配器 → 注入的网关 http.Client → 离线假上游。不是外部模型验收。

const anthropicJSON = `{"id":"msg_1","type":"message","role":"assistant","model":"claude-x",` +
	`"content":[{"type":"text","text":"你好"}],"stop_reason":"end_turn","stop_sequence":null,` +
	`"usage":{"input_tokens":3,"output_tokens":2}}`

func anthropicSSE() string {
	ev := func(name, data string) string { return "event: " + name + "\ndata: " + data + "\n\n" }
	return ev("message_start", `{"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant",`+
		`"model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}`) +
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`) +
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}`) +
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}`) +
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`) +
		ev("message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}`) +
		ev("message_stop", `{"type":"message_stop"}`)
}

type seenReq struct {
	uri    string
	header http.Header
	body   string
}

type fakeMessages struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seen []seenReq
}

func startFakeMessages(t *testing.T) *fakeMessages {
	t.Helper()
	f := &fakeMessages{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.seen = append(f.seen, seenReq{uri: r.URL.RequestURI(), header: r.Header.Clone(), body: string(b)})
		f.mu.Unlock()
		var probe struct {
			Stream bool `json:"stream"`
		}
		_ = json.Unmarshal(b, &probe)
		w.Header().Set("x-nomi-served-model", "served-claude")
		if probe.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, anthropicSSE())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, anthropicJSON)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMessages) requests() []seenReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]seenReq(nil), f.seen...)
}

// countingTransport：模拟网关注入的 http.Client，用来确认请求没有绕过它
type countingTransport struct{ n atomic.Int32 }

func (c *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.n.Add(1)
	return http.DefaultTransport.RoundTrip(r)
}

func TestBuildModelFactoryAnthropicReturnsMessagesModel(t *testing.T) {
	m := BuildModelFactory(Options{ID: "gw", Protocol: "anthropic", BaseURL: "http://127.0.0.1:1"})("claude-x")
	if _, ok := m.(*anthropic.MessagesModel); !ok {
		t.Fatalf("anthropic 分支应返回 Messages 模型，实际 %T", m)
	}
	if m.Provider() != "anthropic.messages" || m.ModelID() != "claude-x" {
		t.Fatalf("provider=%s model=%s", m.Provider(), m.ModelID())
	}
}

func TestIntegrationAnthropicFactoryWiring(t *testing.T) {
	cases := []struct {
		name    string
		baseURL func(srv string) string
		full    bool
		wantURI string
	}{
		{"base URL 补 /v1", func(s string) string { return s + "/proxy" }, false, "/proxy/v1/messages"},
		{"base URL 已带 /v1", func(s string) string { return s + "/v1/" }, false, "/v1/messages"},
		{"完整 URL", func(s string) string { return s + "/custom/endpoint?k=v" }, true, "/custom/endpoint?k=v"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := startFakeMessages(t)
			ct := &countingTransport{}
			full := tc.full
			p, err := NewProvider(Options{ID: "nomi-gateway", Protocol: "anthropic", BaseURL: tc.baseURL(f.srv.URL), FullURL: &full,
				APIKey: "sk-ant", DefaultModel: "claude-x", UserAgent: " nomi-test ", Headers: u.NewObj("x-extra", "1"),
				Client: &http.Client{Transport: ct}, ServedModelHeader: "x-nomi-served-model"}, nil)
			if err != nil {
				t.Fatal(err)
			}

			res, err := p.Chat(context.Background(), &blm.ChatRequest{ReqID: "c1", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}})
			if err != nil {
				t.Fatal(err)
			}
			if res.Content != "你好" || res.Model != "served-claude" || res.FinishReason != "stop" {
				t.Fatalf("chat %s", u.Stringify(res.Obj()))
			}

			var text strings.Builder
			var last blm.ChatChunk
			if err := p.Stream(context.Background(), &blm.ChatRequest{ReqID: "s1", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
				func(c blm.ChatChunk) {
					if c.Type == "delta" {
						text.WriteString(c.Content)
					}
					last = c
				}); err != nil {
				t.Fatal(err)
			}
			if text.String() != "你好" || last.Type != "done" {
				t.Fatalf("stream text=%q last=%s", text.String(), u.Stringify(last.Obj()))
			}

			seen := f.requests()
			if len(seen) != 2 {
				t.Fatalf("requests %d", len(seen))
			}
			if got := ct.n.Load(); got != 2 {
				t.Fatalf("网关 client 应承载全部 2 个请求，实际 %d", got)
			}
			// generateText 的调用级 user-agent 覆盖配置值（与 Node 一致，见 model.go callOptions），只有流式请求带配置的 UA
			wantUA := []string{"ai/", "nomi-test ai-sdk-anthropic/"}
			for i, r := range seen {
				if r.uri != tc.wantURI || r.header.Get("x-api-key") != "sk-ant" || r.header.Get("anthropic-version") != "2023-06-01" ||
					r.header.Get("x-extra") != "1" || !strings.HasPrefix(r.header.Get("user-agent"), wantUA[i]) ||
					r.header.Get("authorization") != "" {
					t.Errorf("request %d uri=%s headers=%v", i, r.uri, r.header)
				}
				if !strings.Contains(r.body, `"model":"claude-x"`) {
					t.Errorf("request %d body %s", i, r.body)
				}
			}
			if strings.Contains(seen[0].body, `"stream":true`) || !strings.Contains(seen[1].body, `"stream":true`) {
				t.Errorf("stream flags: %s | %s", seen[0].body, seen[1].body)
			}
		})
	}
}
