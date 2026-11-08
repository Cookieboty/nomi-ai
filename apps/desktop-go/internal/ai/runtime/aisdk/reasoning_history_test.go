package aisdk

import (
	"context"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

// 前几轮的思考内容不随历史重发（OpenAI 兼容协议会把它作为 reasoning_content 按输入计费）
func TestHistoryReasoningNotResent(t *testing.T) {
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Set([]mockllm.Step{{OK: "1", SSE: sse(`{"id":"d","choices":[{"index":0,"delta":{"content":"ok"}}]}`,
		`{"id":"d","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)}})
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	steps := `[{"role":"assistant","content":[{"type":"reasoning","text":"SECRET-THOUGHTS"},{"type":"tool-call","toolCallId":"c1","toolName":"look","input":{}}]},` +
		`{"role":"tool","content":[{"type":"tool-result","toolCallId":"c1","toolName":"look","output":{"type":"text","value":"seen"}}]},` +
		`{"role":"assistant","content":[{"type":"reasoning","text":"MORE-THOUGHTS"},{"type":"text","text":"done"}]}]`
	if err := p.Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{
		{Role: "user", Content: "q1"}, {Role: "assistant", Content: "done", Steps: steps}, {Role: "user", Content: "q2"},
	}}, func(blm.ChatChunk) {}); err != nil {
		t.Fatal(err)
	}
	body := s.Seen()[0].Body
	if strings.Contains(body, "THOUGHTS") || !strings.Contains(body, "seen") || !strings.Contains(body, "c1") {
		t.Fatal(body)
	}
}
