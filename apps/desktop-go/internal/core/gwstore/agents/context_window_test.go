package agents

import (
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
