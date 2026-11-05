package aisdk

// Nomi 一轮进行中插入用户消息：放回每一步消息列表的位置，前缀标明是用户后来补充的。

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

func steerBase() []*u.Obj {
	return []*u.Obj{
		u.NewObj("role", "user", "content", "q"),
		u.NewObj("role", "assistant", "content", "calling tool"),
		u.NewObj("role", "tool", "content", []any{}),
	}
}

func TestWithSteerInserts(t *testing.T) {
	// 按收到时的位置插入，同一位置按收到顺序，之后每一步都带着
	base := steerBase()
	out := WithSteerInserts(base, []SteerInsert{{At: 3, Text: "first"}, {At: 3, Text: "second"}, {At: 1, Text: "early"}})
	var got []string
	for _, m := range out {
		if m.Get("role") == "user" {
			got = append(got, m.Get("content").(string))
		} else {
			got = append(got, m.Get("role").(string))
		}
	}
	want := []string{"q", SteerPrefix + "\nearly", "assistant", "tool", SteerPrefix + "\nfirst", SteerPrefix + "\nsecond"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", got)
	}
	if len(base) != 3 {
		t.Fatal("input mutated")
	}
	// 没有插入：原样
	if s := WithSteerInserts(base, nil); u.Stringify(toAny(s)) != u.Stringify(toAny(base)) {
		t.Fatal(u.Stringify(toAny(s)))
	}
}

func toAny(ms []*u.Obj) []any {
	out := make([]any, len(ms))
	for i, m := range ms {
		out[i] = m
	}
	return out
}

func TestProviderSteerDuringToolLoop(t *testing.T) {
	// 工具执行期间插入：下一步的请求带上这条用户消息；请求结束后不再收
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Set([]mockllm.Step{
		{OK: "1", SSE: sse(`{"id":"a","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"look","arguments":"{}"}}]}}]}`,
			`{"id":"a","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`)},
		{OK: "1", SSE: sse(`{"id":"b","choices":[{"index":0,"delta":{"content":"ok"}}]}`,
			`{"id":"b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`)},
	})
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	steered := false
	defs := []tools.Definition{{Name: "look", Description: "look", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		steered = p.Steer("r1", "顺便看看文档")
		return "seen", nil
	}}}
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r1", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
		func(blm.ChatChunk) {}); err != nil {
		t.Fatal(err)
	}
	if !steered {
		t.Fatal("steer during the tool loop should be accepted")
	}
	seen := s.Seen()
	if len(seen) != 2 {
		t.Fatalf("requests %d", len(seen))
	}
	if strings.Contains(seen[0].Body, "顺便看看文档") {
		t.Fatalf("first step must not carry the insert: %s", seen[0].Body)
	}
	var body struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(seen[1].Body), &body); err != nil || len(body.Messages) == 0 {
		t.Fatal(err, seen[1].Body)
	}
	last := body.Messages[len(body.Messages)-1]
	if last.Role != "user" || !strings.Contains(string(last.Content), SteerPrefix+`\n顺便看看文档`) {
		t.Fatalf("last message %s %s", last.Role, last.Content)
	}
	if p.Steer("r1", "late") {
		t.Fatal("steer after the request should be false")
	}
	// 没有工具循环的流式请求不收
	if p.Steer("nope", "x") {
		t.Fatal("unknown request should be false")
	}
}

func TestProviderSteerOnFinalStep(t *testing.T) {
	// 在最后一步收到（没有下一步可并进去）：带上它续跑一轮，只出一次 done，用量合并；结束后不再收
	s, err := mockllm.StartScripted(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	text := func(id, t string) string {
		return sse(`{"id":"`+id+`","choices":[{"index":0,"delta":{"content":"`+t+`"}}]}`,
			`{"id":"`+id+`","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
			`{"id":"`+id+`","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`)
	}
	s.Set([]mockllm.Step{{OK: "1", SSE: text("a", "first")}, {OK: "1", SSE: text("b", "second")}})
	p, err := NewProvider(Options{ID: "test", BaseURL: "http://" + s.HostPort, APIKey: "k", DefaultModel: "m"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defs := []tools.Definition{{Name: "noop", Description: "noop", Execute: func(context.Context, any, tools.ExecContext) (any, error) {
		return "x", nil
	}}}
	var chunks []blm.ChatChunk
	steered := false
	if err := p.WithTools(defs).Stream(context.Background(), &blm.ChatRequest{ReqID: "r2", Messages: []blm.ChatMessage{{Role: "user", Content: "hi"}}},
		func(c blm.ChatChunk) {
			chunks = append(chunks, c)
			if c.Type == "delta" && len(chunks) == 1 {
				steered = p.Steer("r2", "再补一句")
			}
		}); err != nil {
		t.Fatal(err)
	}
	if !steered {
		t.Fatal("steer on the final step should be accepted")
	}
	seen := s.Seen()
	if len(seen) != 2 {
		t.Fatalf("requests %d", len(seen))
	}
	var body struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(seen[1].Body), &body); err != nil || len(body.Messages) < 3 {
		t.Fatal(err, seen[1].Body)
	}
	// 上一轮的回复留在上下文里，插入消息在它之后
	if prev := body.Messages[len(body.Messages)-2]; prev.Role != "assistant" || !strings.Contains(string(prev.Content), "first") {
		t.Fatalf("previous reply %s %s", prev.Role, prev.Content)
	}
	last := body.Messages[len(body.Messages)-1]
	if last.Role != "user" || !strings.Contains(string(last.Content), "再补一句") {
		t.Fatalf("last message %s %s", last.Role, last.Content)
	}
	dones := 0
	var promptTokens float64 = -1
	for _, c := range chunks {
		if c.Type == "done" {
			dones++
		}
		if c.Type == "usage" && promptTokens < 0 {
			promptTokens = c.Usage.PromptTokens
		}
	}
	if dones != 1 || promptTokens != 10 {
		t.Fatalf("dones=%d promptTokens=%v", dones, promptTokens)
	}
	if p.Steer("r2", "late") {
		t.Fatal("steer after the request should be false")
	}
}
