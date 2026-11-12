package upstream

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func chatBody() *u.Obj {
	return u.NewObj("model", "m", "temperature", 0.7, "messages", []any{u.NewObj("role", "user", "content", "hi")})
}

func mapLevel(t *testing.T, model, wire, level string, extra ...config.RuntimeModel) string {
	t.Helper()
	m := config.RuntimeModel{ID: model, Enabled: true}
	if len(extra) > 0 {
		m = extra[0]
		m.ID = model
		m.Enabled = true
	}
	p := relay(m)
	out, err := Body(wire, candOf(p, model, wire), chatBody(), BodyOpts{BindingEffort: &level})
	if err != nil {
		t.Fatal(err)
	}
	return u.Stringify(out)
}

func TestThinkingLevelReachesUpstream(t *testing.T) {
	cases := []struct {
		model, wire, level string
		want               []string
		absent             []string
	}{
		{"gpt-5", "chat", "low", []string{`"reasoning_effort":"low"`}, []string{`"thinking"`}},
		{"gpt-5", "responses", "low", []string{`"effort":"low"`}, []string{`"reasoning_effort"`}},
		{"o3", "chat", "medium", []string{`"reasoning_effort":"medium"`}, nil},
		{"claude-sonnet-4-5", "messages", "low", []string{`"type":"enabled"`, `"budget_tokens":`}, []string{`"temperature"`}},
		// 非官方中转会去掉 output_config（Anthropic 专有）。思考类型仍是 adaptive。
		{"claude-opus-4-5", "messages", "low", []string{`"type":"adaptive"`}, []string{`"temperature"`, `"budget_tokens"`}},
		{"claude-sonnet-4-5", "messages", "off", []string{`"type":"disabled"`}, []string{`"budget_tokens"`}},
		{"gemini-2.5-pro", "gemini", "medium", []string{`"thinkingBudget":`, `"includeThoughts":true`}, []string{`"thinkingLevel"`}},
		{"gemini-2.5-flash", "gemini", "off", []string{`"thinkingBudget":0`}, []string{`"includeThoughts"`}},
		{"gemini-3-flash-preview", "gemini", "low", []string{`"thinkingLevel":"low"`, `"includeThoughts":true`}, []string{`"thinkingBudget"`}},
		{"deepseek-v3.2", "chat", "on", []string{`"thinking":{"type":"enabled"}`}, []string{`"reasoning_effort"`}},
		{"deepseek-v3.2", "chat", "off", []string{`"thinking":{"type":"disabled"}`}, nil},
		{"deepseek-chat-v3-0324", "chat", "on", nil, []string{`"thinking"`, `"enable_thinking"`, `"reasoning_effort"`}},
		{"qwen3-235b-a22b", "chat", "low", []string{`"enable_thinking":true`, `"thinking_budget":`}, nil},
		{"qwen3-235b-a22b", "chat", "off", []string{`"enable_thinking":false`}, []string{`"thinking_budget"`}},
		{"qwen3-max", "chat", "on", []string{`"enable_thinking":true`}, []string{`"thinking_budget"`, `"reasoning_effort"`}},
		{"qwen3-max", "chat", "off", []string{`"enable_thinking":false`}, nil},
		{"kimi-k2.5", "chat", "on", []string{`"thinking":{"type":"enabled"}`}, nil},
		{"glm-4.6", "chat", "off", []string{`"thinking":{"type":"disabled"}`}, nil},
		{"grok-4.7", "chat", "medium", []string{`"reasoning_effort":"medium"`}, []string{`"thinking"`}},
		{"grok-4.20", "responses", "high", []string{`"effort":"high"`}, nil},
		{"gpt-4o", "chat", "high", nil, []string{`"reasoning_effort"`, `"thinking"`, `"enable_thinking"`}},
	}
	for _, c := range cases {
		got := mapLevel(t, c.model, c.wire, c.level)
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s %s %s: missing %s in %s", c.model, c.wire, c.level, w, got)
			}
		}
		for _, a := range c.absent {
			if strings.Contains(got, a) {
				t.Errorf("%s %s %s: unexpected %s in %s", c.model, c.wire, c.level, a, got)
			}
		}
	}
}

func TestOfficialAnthropicKeepsEffort(t *testing.T) {
	p := &config.RuntimeProvider{ID: "anthropic", Name: "Anthropic", Enabled: true,
		URLs:   u.NewObj("messages", "https://api.anthropic.com"),
		Keys:   []config.RuntimeKey{{ID: "k1", Value: "sk-ant", Enabled: true}},
		Models: []config.RuntimeModel{{ID: "claude-opus-4-5", Enabled: true}}}
	level := "low"
	out, err := Body("messages", candOf(p, "claude-opus-4-5", "messages"), chatBody(), BodyOpts{BindingEffort: &level})
	if err != nil {
		t.Fatal(err)
	}
	s := u.Stringify(out)
	if !strings.Contains(s, `"type":"adaptive"`) || !strings.Contains(s, `"output_config":{"effort":"low"}`) {
		t.Fatalf("official anthropic: %s", s)
	}
}

func TestMarkedNonThinkingSendsNothing(t *testing.T) {
	no := false
	got := mapLevel(t, "gpt-5", "chat", "high", config.RuntimeModel{Reasoning: &no})
	if strings.Contains(got, "reasoning_effort") || strings.Contains(got, "thinking") {
		t.Fatalf("user marked non-thinking, got %s", got)
	}
}
