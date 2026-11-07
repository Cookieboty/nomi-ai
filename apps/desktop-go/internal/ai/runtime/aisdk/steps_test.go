package aisdk

// 跨轮的提示缓存：上一轮工具循环的记录（steps）下一轮原样发回，请求前缀与上一轮最后一次请求一致；
// 同一会话带同一个 prompt_cache_key；Anthropic 协议打缓存断点。

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/mockllm"
)

func chatBody(t *testing.T, raw string) (msgs []json.RawMessage, all map[string]json.RawMessage) {
	t.Helper()
	if err := json.Unmarshal([]byte(raw), &all); err != nil {
		t.Fatal(err, raw)
	}
	if err := json.Unmarshal(all["messages"], &msgs); err != nil {
		t.Fatal(err, raw)
	}
	return msgs, all
}

func TestStepsReplayKeepsRequestPrefix(t *testing.T) {
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	toolCall := sse(`{"id":"a","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"look","arguments":"{\"z\":1,\"a\":\"x\"}"}}]}}]}`,
		`{"id":"a","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)
	answer := func(text string) string {
		return sse(`{"id":"b","choices":[{"index":0,"delta":{"content":"`+text+`"}}]}`,
			`{"id":"b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)
	}
	s.Set([]mockllm.Step{{OK: "1", SSE: toolCall}, {OK: "1", SSE: answer("ok")}, {OK: "1", SSE: answer("again")}})
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		return "seen", nil
	}}}
	extra := map[string]any{"conversationId": "c-1"}
	first := []blm.ChatMessage{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi", Context: "【记忆】喜欢猫"}}
	var steps []string
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r1", Messages: first, Extra: extra},
		func(c blm.ChatChunk) {
			if c.Type == "steps" {
				steps = append(steps, c.Steps)
			}
		}); err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 {
		t.Fatalf("steps chunks %d", len(steps))
	}
	// 记录：工具调用（参数键序原样）+ 工具结果 + 最后的回复
	if !strings.Contains(steps[0], `"input":{"z":1,"a":"x"}`) || !strings.Contains(steps[0], `"role":"tool"`) || !strings.Contains(steps[0], `"text":"ok"`) {
		t.Fatalf("steps %s", steps[0])
	}

	second := append(append([]blm.ChatMessage{}, first...),
		blm.ChatMessage{Role: "assistant", Content: "ok", Steps: steps[0]},
		blm.ChatMessage{Role: "user", Content: "next"})
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r2", Messages: second, Extra: extra},
		func(blm.ChatChunk) {}); err != nil {
		t.Fatal(err)
	}
	seen := s.Seen()
	if len(seen) != 3 {
		t.Fatalf("requests %d", len(seen))
	}
	prev, prevAll := chatBody(t, seen[1].Body)
	next, nextAll := chatBody(t, seen[2].Body)
	if len(next) != len(prev)+2 {
		t.Fatalf("turn 2 messages %d, turn 1 last request %d", len(next), len(prev))
	}
	for i := range prev {
		if string(prev[i]) != string(next[i]) {
			t.Fatalf("prefix differs at %d:\n%s\n%s", i, prev[i], next[i])
		}
	}
	// 记忆放在用户原话前面，不进 system
	if !strings.Contains(string(prev[1]), `【记忆】喜欢猫\n\nhi`) || strings.Contains(string(prev[0]), "喜欢猫") {
		t.Fatalf("memory placement %s / %s", prev[0], prev[1])
	}
	for _, all := range []map[string]json.RawMessage{prevAll, nextAll} {
		if string(all["prompt_cache_key"]) != `"nomi-c-1"` {
			t.Fatalf("prompt_cache_key %s", all["prompt_cache_key"])
		}
	}
}

func TestStepsOnlyWithToolCalls(t *testing.T) {
	// 只有一条回复（没有工具调用）：不发 steps，下一轮按正文发
	if s := StepsJSON([]*u.Obj{u.NewObj("role", "assistant", "content", []any{u.NewObj("type", "text", "text", "hi")})}); s != "" {
		t.Fatal(s)
	}
	if s := StepsJSON(nil); s != "" {
		t.Fatal(s)
	}
}

func TestParseStepsRejectsBadRecords(t *testing.T) {
	for _, raw := range []string{"", "not json", "{}", "[]", `[{"role":"system","content":"x"}]`, `[{"role":"tool","content":"x"}]`, `[1]`} {
		if parseSteps(raw) != nil {
			t.Fatalf("%q should fall back to text", raw)
		}
	}
	// 坏记录退回按正文发
	_, rest := SplitPrompt([]blm.ChatMessage{{Role: "assistant", Content: "plain", Steps: "oops"}})
	if len(rest) != 1 || rest[0].Get("content") != "plain" {
		t.Fatal(u.Stringify(toAny(rest)))
	}
}

func TestCacheOptions(t *testing.T) {
	req := &blm.ChatRequest{Extra: map[string]any{"conversationId": "c9"}}
	think := u.NewObj("test", u.NewObj("reasoningEffort", "medium"))
	chat := &Provider{ID: "test", opts: Options{}}
	got := chat.cacheOptions(think, req)
	if u.Stringify(got) != `{"test":{"reasoningEffort":"medium","prompt_cache_key":"nomi-c9"}}` {
		t.Fatal(u.Stringify(got))
	}
	if u.Stringify(think) != `{"test":{"reasoningEffort":"medium"}}` {
		t.Fatal("input mutated")
	}
	resp := &Provider{ID: "test", opts: Options{Protocol: "openai-responses"}}
	if s := u.Stringify(resp.cacheOptions(nil, req)); s != `{"openai":{"promptCacheKey":"nomi-c9"}}` {
		t.Fatal(s)
	}
	anth := &Provider{ID: "test", opts: Options{Protocol: "anthropic"}}
	if anth.cacheOptions(nil, req) != nil {
		t.Fatal("anthropic uses breakpoints, not a cache key")
	}
	if chat.cacheOptions(nil, &blm.ChatRequest{}) != nil {
		t.Fatal("no conversation, no key")
	}
}

func TestMarkCacheBreakpoints(t *testing.T) {
	prompt, err := convertPrompt(ptr("sys"), []*u.Obj{
		u.NewObj("role", "user", "content", "a"),
		u.NewObj("role", "assistant", "content", "b"),
		u.NewObj("role", "user", "content", "c"),
	})
	if err != nil {
		t.Fatal(err)
	}
	markCacheBreakpoints(prompt)
	marked := 0
	for i, x := range prompt {
		m := x.(*u.Obj)
		if m.Get("providerOptions") != nil {
			marked++
			if i != 0 && i != len(prompt)-1 {
				t.Fatalf("breakpoint on %d", i)
			}
		}
	}
	if marked != 2 {
		t.Fatalf("marked %d", marked)
	}
	if !strings.Contains(u.Stringify(prompt[0]), `"cacheControl":{"type":"ephemeral"}`) {
		t.Fatal(u.Stringify(prompt[0]))
	}
}

func ptr(s string) *string { return &s }

func TestAnthropicRequestCarriesCacheBreakpoints(t *testing.T) {
	f := startFakeMessages(t)
	p, err := NewProvider(Options{ID: "nomi-gateway", Protocol: "anthropic", BaseURL: f.srv.URL + "/v1", APIKey: "k", DefaultModel: "claude-x"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	msgs := []blm.ChatMessage{{Role: "system", Content: "sys"}, {Role: "user", Content: "a"}, {Role: "assistant", Content: "b"}, {Role: "user", Content: "c"}}
	if err := p.Stream(context.Background(), &blm.ChatRequest{ReqID: "s1", Messages: msgs, Extra: map[string]any{"conversationId": "c1"}}, func(blm.ChatChunk) {}); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests %d", len(reqs))
	}
	var body struct {
		System   []map[string]any `json:"system"`
		Messages []struct {
			Content []map[string]any `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(reqs[0].body), &body); err != nil {
		t.Fatal(err, reqs[0].body)
	}
	if len(body.System) != 1 || body.System[0]["cache_control"] == nil {
		t.Fatalf("system %s", reqs[0].body)
	}
	last := body.Messages[len(body.Messages)-1].Content
	if last[len(last)-1]["cache_control"] == nil || body.Messages[0].Content[0]["cache_control"] != nil {
		t.Fatalf("messages %s", reqs[0].body)
	}
	if strings.Contains(reqs[0].body, "prompt_cache_key") {
		t.Fatal("anthropic body must not carry prompt_cache_key")
	}
}
