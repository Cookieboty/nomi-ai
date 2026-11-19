package upstream

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
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
		// Claude 中转保留 output_config.effort，以支持 adaptive thinking
		{"claude-opus-4-5", "messages", "low", []string{`"type":"adaptive"`, `"output_config":{"effort":"low"}`}, []string{`"temperature"`, `"budget_tokens"`}},
		{"claude-opus-5-5", "messages", "high", []string{`"type":"adaptive"`, `"output_config":{"effort":"high"}`}, []string{`"temperature"`, `"budget_tokens"`}},
		{"claude-opus-5-5", "messages", "off", nil, []string{`"thinking"`, `"budget_tokens"`, `"disabled"`}},
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

// agent 第三方标签选的档位要压过 CLI 自己带的推理参数（Codex 每个请求都带 reasoning.effort），
// 否则输入栏里的思考深度对 CLI 不生效；CLI 明确关掉思考的辅助请求保持关闭。
func TestBindingEffortOverridesClientExplicit(t *testing.T) {
	p := relay(config.RuntimeModel{ID: "grok-4.20", Enabled: true})
	codexBody := func() *u.Obj {
		return u.NewObj("model", "m", "input", []any{}, "reasoning", u.NewObj("effort", "medium", "summary", "auto"))
	}
	level := "high"
	out, err := Body("responses", candOf(p, "grok-4.20", "responses"), codexBody(), BodyOpts{Client: "codex", BindingEffort: &level})
	if err != nil {
		t.Fatal(err)
	}
	if s := u.Stringify(out); !strings.Contains(s, `"effort":"high"`) || strings.Contains(s, `"effort":"medium"`) {
		t.Fatalf("binding effort should win over the CLI's own effort: %s", s)
	}
	none, err := Body("responses", candOf(p, "grok-4.20", "responses"), codexBody(), BodyOpts{Client: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if s := u.Stringify(none); !strings.Contains(s, `"effort":"medium"`) {
		t.Fatalf("without a binding the CLI's own effort is kept: %s", s)
	}
	ds := relay(config.RuntimeModel{ID: "deepseek-v3.2", Enabled: true})
	off := u.NewObj("model", "m", "messages", []any{u.NewObj("role", "user", "content", "hi")}, "thinking", u.NewObj("type", "disabled"))
	kept, err := Body("messages", candOf(ds, "deepseek-v3.2", "chat"), off, BodyOpts{Client: "claude", BindingEffort: &level})
	if err != nil {
		t.Fatal(err)
	}
	if s := u.Stringify(kept); strings.Contains(s, `"type":"enabled"`) {
		t.Fatalf("explicitly disabled helper request must stay off: %s", s)
	}
}

// 自定义模型的 like / efforts 由网关按真实模型对象把 Nomi 带来的档位写进上游参数（#362）
func TestCustomModelLevelFromStoredProfile(t *testing.T) {
	like := "gpt-5"
	got := mapLevel(t, "my-model", "chat", "high", config.RuntimeModel{Like: &like})
	if !strings.Contains(got, `"reasoning_effort":"high"`) {
		t.Fatalf("like=gpt-5: %s", got)
	}
	got = mapLevel(t, "my-model", "chat", "medium", config.RuntimeModel{Efforts: []string{"low", "medium", "high"}})
	if !strings.Contains(got, `"reasoning_effort":"medium"`) {
		t.Fatalf("efforts: %s", got)
	}
	no := false
	got = mapLevel(t, "my-model", "chat", "high", config.RuntimeModel{Like: &like, Reasoning: &no})
	if strings.Contains(got, `"reasoning_effort"`) {
		t.Fatalf("reasoning=false must not send a level: %s", got)
	}
}

func TestClaudeSameWirePassthroughAndLegacyUpgrade(t *testing.T) {
	p := relay(
		config.RuntimeModel{ID: "claude-opus-5-5", Enabled: true},
		config.RuntimeModel{ID: "claude-opus-4-5", Enabled: true, Efforts: []string{"low", "medium", "high"}},
		config.RuntimeModel{ID: "deepseek-v3.2", Enabled: true},
	)
	// 无 BindingEffort 时客户端的 adaptive 请求原样透传
	adaptiveBody := u.NewObj("model", "m", "thinking", u.NewObj("type", "adaptive"), "output_config", u.NewObj("effort", "high"),
		"messages", []any{u.NewObj("role", "user", "content", "hi")})
	out, err := Body("messages", candOf(p, "claude-opus-5-5", "messages"), adaptiveBody, BodyOpts{Client: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	s := u.Stringify(out)
	if !strings.Contains(s, `"type":"adaptive"`) || !strings.Contains(s, `"output_config":{"effort":"high"}`) {
		t.Fatalf("same-wire adaptive passthrough: %s", s)
	}

	// 外部旧客户端带了 budget_tokens 打到纯 adaptive 模型时自动升级为 adaptive
	legacyBody := u.NewObj("model", "m", "temperature", 0.5, "thinking", u.NewObj("type", "enabled", "budget_tokens", 16000.0),
		"messages", []any{u.NewObj("role", "user", "content", "hi")})
	upgraded, err := Body("messages", candOf(p, "claude-opus-5-5", "messages"), legacyBody, BodyOpts{Client: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	us := u.Stringify(upgraded)
	if !strings.Contains(us, `"type":"adaptive"`) || !strings.Contains(us, `"output_config":{"effort":"high"}`) || strings.Contains(us, `"budget_tokens"`) || strings.Contains(us, `"temperature"`) {
		t.Fatalf("legacy budget_tokens should upgrade to adaptive: %s", us)
	}

	// 外部客户端发 disabled 打到禁止禁用的 adaptive 模型时自动省略 thinking
	disabledBody := u.NewObj("model", "m", "thinking", u.NewObj("type", "disabled"),
		"messages", []any{u.NewObj("role", "user", "content", "hi")})
	omitted, err := Body("messages", candOf(p, "claude-opus-5-5", "messages"), disabledBody, BodyOpts{Client: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if os := u.Stringify(omitted); strings.Contains(os, `"thinking"`) {
		t.Fatalf("canDisable=false adaptive model should omit thinking: %s", os)
	}

	// 自定义 efforts / learned efforts 不会把 Claude adaptive 模型退化成 budget_tokens
	level := "medium"
	kept45, err := Body("messages", candOf(p, "claude-opus-4-5", "messages"), chatBody(), BodyOpts{BindingEffort: &level})
	if err != nil {
		t.Fatal(err)
	}
	if ks := u.Stringify(kept45); !strings.Contains(ks, `"type":"adaptive"`) || strings.Contains(ks, `"budget_tokens"`) {
		t.Fatalf("efforts override must keep adaptive: %s", ks)
	}
	learned := &config.LearnedState{Models: map[string]config.LearnedModel{
		"claude-opus-5-5": {Efforts: []string{"low", "medium", "high"}, At: 1e18, CatalogVersion: models.CatalogVersion},
	}}
	effSpec := models.EffectiveModel(p, "claude-opus-5-5", learned, models.EffectiveOpts{})
	if c := effSpec.Get("reasoning").(*u.Obj).Get("control"); c != "adaptive" {
		t.Fatalf("learned efforts should keep adaptive control, got %v", c)
	}

	// 非 Claude 模型走非官方 messages 仍然去掉 output_config
	nonClaudeBody := u.NewObj("model", "m", "output_config", u.NewObj("effort", "high"),
		"messages", []any{u.NewObj("role", "user", "content", "hi")})
	dsOut, err := Body("messages", candOf(p, "deepseek-v3.2", "messages"), nonClaudeBody, BodyOpts{Client: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if ds := u.Stringify(dsOut); strings.Contains(ds, `"output_config"`) {
		t.Fatalf("non-Claude messages upstream should still strip output_config: %s", ds)
	}
}
