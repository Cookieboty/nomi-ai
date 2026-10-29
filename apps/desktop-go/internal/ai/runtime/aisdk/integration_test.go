package aisdk

import (
	"context"
	"strings"
	"sync"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

// Integration: AiSdkLlmProvider → BuildModelFactory → compatible adapter → real HTTP (mockllm).

func collect(t *testing.T, p interface {
	Stream(context.Context, *blm.ChatRequest, func(blm.ChatChunk)) error
}, r *blm.ChatRequest) []blm.ChatChunk {
	t.Helper()
	var out []blm.ChatChunk
	var mu sync.Mutex
	if err := p.Stream(context.Background(), r, func(c blm.ChatChunk) { mu.Lock(); out = append(out, c); mu.Unlock() }); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestIntegrationCompatibleMockLLM(t *testing.T) {
	base, err := mockllm.Start()
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewProvider(Options{ID: "mock", BaseURL: base, APIKey: "sk", DefaultModel: "mock"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cs := collect(t, p, &blm.ChatRequest{ReqID: "r1", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}})
	var text strings.Builder
	var last blm.ChatChunk
	for _, c := range cs {
		if c.Type == "delta" {
			text.WriteString(c.Content)
		}
		last = c
	}
	if !strings.HasPrefix(text.String(), "你好呀") || last.Type != "done" {
		t.Fatalf("text=%q last=%s", text.String(), u.Stringify(last.Obj()))
	}
}

func sse(lines ...string) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString("data: " + l + "\n\n")
	}
	return b.String() + "data: [DONE]\n\n"
}

func TestIntegrationToolLoopFullURL(t *testing.T) {
	s, err := mockllm.StartScripted([]string{"authorization", "user-agent", "x-extra"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Set([]mockllm.Step{
		{OK: "1", SSE: sse(`{"id":"a","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":"{\"x\":1}"}}]}}]}`,
			`{"id":"a","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
			`{"id":"a","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)},
		{OK: "1", SSE: sse(`{"id":"b","choices":[{"index":0,"delta":{"content":"ok"}}]}`,
			`{"id":"b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
			`{"id":"b","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}`)},
	})
	full := true
	p, err := NewProvider(Options{ID: "scr", BaseURL: "http://" + s.HostPort + "/custom/endpoint?k=v", FullURL: &full, APIKey: "sk-x",
		DefaultModel: "m1", UserAgent: " nomi-test ", Headers: u.NewObj("x-extra", "1")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var execs []string
	defs := []tools.Definition{{Name: "echo", Description: "", Execute: func(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
		mu.Lock()
		execs = append(execs, u.Stringify(in)+"|"+ec.CallerTabID)
		mu.Unlock()
		return "pong", nil
	}}}
	ctx := tools.RunWithToolCaller(context.Background(), "tab-7")
	var cs []blm.ChatChunk
	if err := p.WithTools(defs).Stream(ctx, &blm.ChatRequest{ReqID: "r2", Messages: []blm.ChatMessage{{Role: "user", Content: "go"}}},
		func(c blm.ChatChunk) { cs = append(cs, c) }); err != nil {
		t.Fatal(err)
	}
	seen := s.Seen()
	if len(seen) != 2 {
		t.Fatalf("requests %d", len(seen))
	}
	for _, r := range seen {
		if r.URL != "/custom/endpoint?k=v" || r.Headers["authorization"] != "Bearer sk-x" || !strings.HasPrefix(r.Headers["user-agent"], "nomi-test ai-sdk-openai-compatible/") || r.Headers["x-extra"] != "1" {
			t.Errorf("request %+v", r)
		}
	}
	if !strings.Contains(seen[0].Body, `"description":""`) {
		t.Errorf("D-B5-5: empty description must be sent: %s", seen[0].Body)
	}
	if !strings.Contains(seen[1].Body, `"role":"tool"`) || !strings.Contains(seen[1].Body, `"tool_call_id":"call_1"`) {
		t.Errorf("tool result not sent back: %s", seen[1].Body)
	}
	if len(execs) != 1 || execs[0] != `{"x":1}|tab-7` {
		t.Errorf("execs %v", execs)
	}
	if last := cs[len(cs)-1]; last.Type != "done" {
		t.Errorf("last %s", u.Stringify(last.Obj()))
	}
}
