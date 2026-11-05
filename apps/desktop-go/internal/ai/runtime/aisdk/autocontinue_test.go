package aisdk

// 一轮的工具步数用完、模型还要接着调工具：自动续一轮，只出一次 done；续轮时较早的大段工具输出被缩短。

import (
	"context"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

func toolCallStep(id string) mockllm.Step {
	return mockllm.Step{OK: "1", SSE: sse(`{"id":"`+id+`","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"`+id+`","type":"function","function":{"name":"look","arguments":"{}"}}]}}]}`,
		`{"id":"`+id+`","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)}
}

func TestProviderAutoContinueAfterStepLimit(t *testing.T) {
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// 每轮 2 步：第 1 轮两步都调工具（步数用完），第 2 轮先调一次工具再答完
	s.Set([]mockllm.Step{toolCallStep("c1"), toolCallStep("c2"), toolCallStep("c3"),
		{OK: "1", SSE: sse(`{"id":"d","choices":[{"index":0,"delta":{"content":"done"}}]}`,
			`{"id":"d","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)}})
	steps := 2
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m", MaxSteps: &steps}, nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		calls++
		return "seen", nil
	}}}
	dones, text := 0, ""
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
		func(c blm.ChatChunk) {
			switch c.Type {
			case "done":
				dones++
			case "delta":
				text += c.Content
			}
		}); err != nil {
		t.Fatal(err)
	}
	if len(s.Seen()) != 4 || calls != 3 || dones != 1 || text != "done" {
		t.Fatalf("requests %d calls %d dones %d text %q", len(s.Seen()), calls, dones, text)
	}
	// 第 2 轮第一步带着第 1 轮最后一步的工具结果
	if body := s.Seen()[2].Body; !strings.Contains(body, "c2") || !strings.Contains(body, "seen") {
		t.Fatal(body)
	}
}

func TestProviderAutoContinueCapped(t *testing.T) {
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	old := MaxAutoRounds
	MaxAutoRounds = 1
	defer func() { MaxAutoRounds = old }()
	s.Set([]mockllm.Step{toolCallStep("c1"), toolCallStep("c2"), toolCallStep("c3")})
	steps := 1
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m", MaxSteps: &steps}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		return "seen", nil
	}}}
	var finish string
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
		func(c blm.ChatChunk) {
			if c.Type == "done" {
				finish = c.FinishReason
			}
		}); err != nil {
		t.Fatal(err)
	}
	// 1 轮 + 续 1 轮，之后停下（finish 仍是 tool_calls）
	if len(s.Seen()) != 2 || finish != "tool_calls" {
		t.Fatalf("requests %d finish %q", len(s.Seen()), finish)
	}
}

func TestCompactToolResults(t *testing.T) {
	long := strings.Repeat("长", 2000)
	tool := func(id, v string) *u.Obj {
		return u.NewObj("role", "tool", "content", []any{u.NewObj("type", "tool-result", "toolCallId", id, "toolName", "fs_read_text",
			"output", u.NewObj("type", "text", "value", v))})
	}
	hist := tool("h", long) // 用户的历史（from 之前）：不动
	msgs := []*u.Obj{hist, tool("a", long), tool("b", "short"), tool("c", long)}
	out := CompactToolResults(msgs, 1, 1)
	value := func(m *u.Obj) string {
		return m.Get("content").([]any)[0].(*u.Obj).Get("output").(*u.Obj).Get("value").(string)
	}
	if value(out[0]) != long || value(out[3]) != long || value(out[2]) != "short" {
		t.Fatal("history, the most recent and short outputs stay")
	}
	if v := value(out[1]); len([]rune(v)) > compactHeadRunes+60 || !strings.Contains(v, "已省略 1400 字") {
		t.Fatal(v)
	}
	if value(msgs[1]) != long {
		t.Fatal("input mutated")
	}
	// 工具消息不多于 keep：原样返回
	if got := CompactToolResults(msgs, 1, 3); &got[0] != &msgs[0] {
		t.Fatal("should return the input unchanged")
	}
}
