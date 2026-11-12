package models

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestThinkingProfileSecondTier(t *testing.T) {
	cases := []struct {
		model   string
		levels  string
		def     string
		control string
	}{
		{"gpt-5", "minimal,low,medium,high", "low", "effort"},
		{"o3", "low,medium,high", "medium", "effort"},
		{"o4-mini", "low,medium,high", "medium", "effort"},
		{"claude-sonnet-4-5", "off,low,medium,high", "low", "budget"},
		{"claude-opus-4-5", "off,low,medium,high", "low", "adaptive"},
		{"gemini-2.5-pro", "low,medium,high", "medium", "budget"},
		{"gemini-2.5-flash", "off,low,medium,high", "low", "budget"},
		{"gemini-3-flash-preview", "minimal,low,medium,high", "low", "effort"},
		{"deepseek-chat", "off,on", "on", "toggle"},
		{"deepseek-v3.2", "off,on", "on", "toggle"},
		{"deepseek-chat-v3-0324", "", "", ""},
		{"deepseek-r1-0528", "", "", ""},
		{"qwen3-235b-a22b", "off,low,medium,high", "low", "budget"},
		{"qwen3-max", "off,on", "on", "toggle"},
		{"kimi-k2.5", "off,on", "on", "toggle"},
		{"kimi-k2-thinking", "", "", ""},
		{"glm-4.6", "off,on", "on", "toggle"},
		{"grok-4.20", "low,medium,high", "medium", "effort"},
		{"grok-4.7", "low,medium,high,xhigh", "medium", "effort"},
		{"grok-4.20-0309-non-reasoning", "", "", ""},
		{"gpt-4o", "", "", ""},
		{"gpt-4o-mini", "", "", ""},
	}
	for _, c := range cases {
		p := ProfileOf(c.model, nil)
		got := strings.Join(p.Levels, ",")
		if got != c.levels || p.Default != c.def || p.Control != c.control {
			t.Errorf("%s: levels=%q default=%q control=%q, want levels=%q default=%q control=%q",
				c.model, got, p.Default, p.Control, c.levels, c.def, c.control)
		}
		if p.Obj() == nil {
			if c.levels != "" {
				t.Errorf("%s: Obj() is nil", c.model)
			}
			continue
		}
		if c.levels == "" {
			t.Errorf("%s: Obj() should be nil", c.model)
		}
	}
}

func TestThinkingProfileUserOverride(t *testing.T) {
	off := ProfileOf("gpt-5", u.NewObj("reasoning", false))
	if len(off.Levels) != 0 {
		t.Fatalf("reasoning:false should hide the selector, got %v", off.Levels)
	}
	custom := ProfileOf("my-model", u.NewObj("efforts", []any{"low", "high"}))
	if strings.Join(custom.Levels, ",") != "low,high" || custom.Default != "high" || custom.Control != "effort" {
		t.Fatalf("custom efforts: %+v", custom)
	}
	like := ProfileOf("alias", u.NewObj("like", "claude-sonnet-4-5"))
	if like.Control != "budget" || like.Default != "low" {
		t.Fatalf("like: %+v", like)
	}
}

func TestResolveRequestLevel(t *testing.T) {
	if g := ResolveRequestLevel("gpt-5", ""); g != "" {
		t.Fatalf("empty request should not invent a level, got %q", g)
	}
	if g := ResolveRequestLevel("gpt-4o", "high"); g != "" {
		t.Fatalf("non-thinking model should not send a level, got %q", g)
	}
	if g := ResolveRequestLevel("o3", "high"); g != "high" {
		t.Fatalf("supported level: %q", g)
	}
	if g := ResolveRequestLevel("o3", "xhigh"); g != "medium" {
		t.Fatalf("unknown level falls back to the second tier, got %q", g)
	}
	if g := ResolveRequestLevel("deepseek-v3.2", "off"); g != "off" {
		t.Fatalf("off: %q", g)
	}
}

func TestDirectOptionsShape(t *testing.T) {
	qwen := DirectOptions("openai-chat", "dashscope", "qwen3-max", "on")
	if u.Stringify(qwen) != `{"dashscope":{"enable_thinking":true}}` {
		t.Fatalf("qwen on: %s", u.Stringify(qwen))
	}
	qwenOff := DirectOptions("openai-chat", "dashscope", "qwen3-max", "off")
	if u.Stringify(qwenOff) != `{"dashscope":{"enable_thinking":false}}` {
		t.Fatalf("qwen off: %s", u.Stringify(qwenOff))
	}
	ds := DirectOptions("openai-chat", "deepseek", "deepseek-v3.2", "on")
	if u.Stringify(ds) != `{"deepseek":{"thinking":{"type":"enabled"}}}` {
		t.Fatalf("deepseek: %s", u.Stringify(ds))
	}
	gpt := DirectOptions("openai-chat", "openai", "gpt-5", "low")
	if u.Stringify(gpt) != `{"openai":{"reasoningEffort":"low"}}` {
		t.Fatalf("gpt-5: %s", u.Stringify(gpt))
	}
	if DirectOptions("openai-chat", "openai", "gpt-4o", "high") != nil {
		t.Fatal("gpt-4o should not get reasoning params")
	}
	if DirectOptions("anthropic", "anthropic", "claude-sonnet-4-5", "low") != nil {
		t.Fatal("anthropic shape goes through CallReasoning, not provider options")
	}
	if CallReasoning("anthropic", "off") != "none" || CallReasoning("openai-responses", "high") != "high" || CallReasoning("openai-chat", "high") != "" {
		t.Fatal("CallReasoning")
	}
	budget := DirectOptions("openai-chat", "dashscope", "qwen3-235b-a22b", "low")
	s := u.Stringify(budget)
	if !strings.Contains(s, `"enable_thinking":true`) || !strings.Contains(s, `"thinking_budget":`) {
		t.Fatalf("qwen budget: %s", s)
	}
}
