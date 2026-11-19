package agents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCliLaunchUsesEffectiveWindowAndCapsOutput(t *testing.T) {
	ctxW, maxOut := 1_000_000.0, 393_216.0
	meta := func(string) *ModelMeta { return &ModelMeta{Ctx: &ctxW, MaxOutput: &maxOut} }
	dir := t.TempDir()

	cl, err := AgentLaunchFor("claude", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "deepseek/deepseek-v4-pro", Dir: dir, MetaOf: meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cl.Env.Get("CLAUDE_CODE_MAX_CONTEXT_TOKENS") != "1000000" {
		t.Fatalf("context %v", cl.Env.Get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
	}
	if cl.Env.Get("CLAUDE_CODE_MAX_OUTPUT_TOKENS") != "32000" {
		t.Fatalf("output %v", cl.Env.Get("CLAUDE_CODE_MAX_OUTPUT_TOKENS"))
	}
	if _, ok := cl.EnvGet("MAX_THINKING_TOKENS"); ok {
		t.Fatalf("MAX_THINKING_TOKENS should not be injected, got %v", cl.Env.Get("MAX_THINKING_TOKENS"))
	}

	reasonOn := true
	clClaude, err := AgentLaunchFor("claude", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "anthropic/claude-opus-5-5", Dir: filepath.Join(dir, "claude-native"),
		MetaOf: func(string) *ModelMeta {
			return &ModelMeta{Ctx: &ctxW, MaxOutput: &maxOut, Reasoning: &reasonOn, NativeClient: "claude"}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := clClaude.EnvGet("ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"); ok {
		t.Fatalf("Claude target should not override SUPPORTED_CAPABILITIES, got %v", clClaude.Env.Get("ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"))
	}

	clNonClaude, err := AgentLaunchFor("claude", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "deepseek/deepseek-v4-pro", Dir: filepath.Join(dir, "claude-ds"),
		MetaOf: func(string) *ModelMeta {
			return &ModelMeta{Ctx: &ctxW, MaxOutput: &maxOut, Reasoning: &reasonOn}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := clNonClaude.EnvGet("ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"); !ok || got != "thinking,interleaved_thinking" {
		t.Fatalf("non-Claude reasoning target should keep SUPPORTED_CAPABILITIES, got %v (%v)", got, ok)
	}

	cx, err := AgentLaunchFor("codex", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "deepseek/deepseek-v4-pro", Dir: dir, MetaOf: meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cx.Args, "\n")
	if !strings.Contains(joined, "model_context_window=1000000") || !strings.Contains(joined, "model_auto_compact_token_limit=800000") {
		t.Fatalf("codex args:\n%s", joined)
	}

	gm, err := AgentLaunchFor("gemini", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "deepseek/deepseek-v4-pro", Dir: filepath.Join(dir, "gem"), MetaOf: meta,
	})
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := gm.Env.Get("GEMINI_CLI_SYSTEM_SETTINGS_PATH").(string)
	b, err := os.ReadFile(settings)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"maxTokens":1000000`) && !strings.Contains(string(b), `"maxTokens": 1000000`) {
		t.Fatalf("gemini settings %s", b)
	}

	small := 8_000.0
	dh, err := AgentLaunchFor("dsh", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "m", Dir: filepath.Join(dir, "dsh"),
		MetaOf: func(string) *ModelMeta { return &ModelMeta{Ctx: &ctxW, MaxOutput: &small} },
	})
	if err != nil {
		t.Fatal(err)
	}
	yb, err := os.ReadFile(filepath.Join(dir, "dsh", "patch.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(yb), "maxTokens: 8000") || !strings.Contains(string(yb), "contextWindow: 1000000") {
		t.Fatalf("dsh keeps a smaller max output:\n%s", yb)
	}
	_ = dh
}

func TestCodexCatalogMatchesBareModelTemplate(t *testing.T) {
	t.Setenv("CODEX_HOME", "")
	home := t.TempDir()
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cache := `{"models":[
		{"slug":"gpt-5.3-codex","default_reasoning_level":"xhigh","supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"}]},
		{"slug":"gpt-5","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"minimal"},{"effort":"low"},{"effort":"medium"},{"effort":"high"}]}
	]}`
	if err := os.WriteFile(filepath.Join(codexDir, "models_cache.json"), []byte(cache), 0o600); err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(home, "run")
	_, err := AgentLaunchFor("codex", &LaunchContext{
		URL: "http://127.0.0.1:9", Token: "tok", Model: "relay/gpt-5", Home: home, Dir: dir,
		Catalog: []string{"relay/my-gpt", "deepseek/deepseek-v4-pro"},
		MetaOf: func(ref string) *ModelMeta {
			if ref == "relay/my-gpt" {
				return &ModelMeta{Like: "openai/gpt-5"}
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Models []struct {
			Slug             string `json:"slug"`
			DefaultReasoning string `json:"default_reasoning_level"`
			Supported        []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	bySlug := map[string]string{}
	levelsBySlug := map[string]string{}
	for _, m := range parsed.Models {
		bySlug[m.Slug] = m.DefaultReasoning
		var lv []string
		for _, s := range m.Supported {
			lv = append(lv, s.Effort)
		}
		levelsBySlug[m.Slug] = strings.Join(lv, ",")
	}
	if bySlug["relay/gpt-5"] != "medium" || levelsBySlug["relay/gpt-5"] != "minimal,low,medium,high" {
		t.Fatalf("relay/gpt-5 should match gpt-5 template: default=%q levels=%q", bySlug["relay/gpt-5"], levelsBySlug["relay/gpt-5"])
	}
	if bySlug["relay/my-gpt"] != "medium" || levelsBySlug["relay/my-gpt"] != "minimal,low,medium,high" {
		t.Fatalf("relay/my-gpt (like openai/gpt-5) should match gpt-5 template: default=%q levels=%q", bySlug["relay/my-gpt"], levelsBySlug["relay/my-gpt"])
	}
	if bySlug["deepseek/deepseek-v4-pro"] != "xhigh" {
		t.Fatalf("unknown model should fall back to first template: default=%q", bySlug["deepseek/deepseek-v4-pro"])
	}
}
