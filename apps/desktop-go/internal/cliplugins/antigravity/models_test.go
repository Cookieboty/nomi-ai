package antigravity

import (
	"reflect"
	"testing"

	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const sampleAgyModels27 = `
  gemini-4-neon-low               Gemini 4 Neon (Low)
  gemini-4-neon-medium            Gemini 4 Neon (Medium)
  gemini-4-neon-high              Gemini 4 Neon (High)
  gemini-4-neon-xhigh             Gemini 4 Neon (Extra High)
  gemini-4-carbon-low             Gemini 4 Carbon (Low)
  gemini-4-carbon-medium          Gemini 4 Carbon (Medium)
  gemini-4-carbon-high            Gemini 4 Carbon (High)
  gemini-4-carbon-xhigh           Gemini 4 Carbon (Extra High)
  gemini-4-argon-low              Gemini 4 Argon (Low)
  gemini-4-argon-medium           Gemini 4 Argon (Medium)
  gemini-4-argon-high             Gemini 4 Argon (High)
  gemini-4-argon-xhigh            Gemini 4 Argon (Extra High)
  gemini-4-hydrogen-low           Gemini 4 Hydrogen (Low)
  gemini-4-hydrogen-medium        Gemini 4 Hydrogen (Medium)
  gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)
  gemini-4-hydrogen-xhigh         Gemini 4 Hydrogen (Extra High)
  gemini-3.8-flash-low            Gemini 3.8 Flash (Low)
  gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)
  gemini-3.8-flash-high           Gemini 3.8 Flash (High)
  claude-opus-5-5-medium          Claude Opus 5.5 (Medium)
  claude-opus-5-5-high            Claude Opus 5.5 (High)
  claude-sonnet-5-5-medium        Claude Sonnet 5.5 (Medium)
  claude-sonnet-5-5-high          Claude Sonnet 5.5 (High)
  gemini-pro-orchestrator-neon    Gemini Pro Orchestrator Neon
  gemini-pro-orchestrator         Gemini Pro Orchestrator
  gemini-pro-orchestrator-argon   Gemini Pro Orchestrator Argon
  gpt-oss-120b-medium             GPT-OSS 120B (Medium)
`

func findCatalogModel(t *testing.T, cat *util.Obj, id string) *util.Obj {
	t.Helper()
	models, _ := cat.Get("models").([]any)
	for _, raw := range models {
		m := sh.AsObj(raw)
		if m != nil && m.Get("id") == id {
			return m
		}
	}
	return nil
}

func TestParseModelsCLIAggregatesAndKeepsSingleAndOrchestrator(t *testing.T) {
	cat := ParseModelsCLI(sampleAgyModels27, `{"model":"gemini-4-neon-xhigh"}`)
	models, _ := cat.Get("models").([]any)
	// 7 aggregated base models + 3 orchestrators + 1 single-suffix gpt-oss-120b-medium = 11
	if len(models) != 11 {
		t.Fatalf("len(models) = %d, want 11 (%s)", len(models), util.Stringify(cat))
	}

	neon := findCatalogModel(t, cat, "gemini-4-neon")
	if neon == nil {
		t.Fatalf("missing aggregated gemini-4-neon")
	}
	if neon.Get("reasoning") != true || neon.Get("label") != "Gemini 4 Neon" {
		t.Fatalf("unexpected neon entry: %s", util.Stringify(neon))
	}
	if got := neon.Get("efforts"); !reflect.DeepEqual(got, []any{"low", "medium", "high", "xhigh"}) {
		t.Fatalf("neon efforts = %#v", got)
	}
	if em := sh.AsObj(neon.Get("effortModels")); em == nil || em.Get("xhigh") != "gemini-4-neon-xhigh" || em.Get("low") != "gemini-4-neon-low" {
		t.Fatalf("neon effortModels = %s", util.Stringify(em))
	}
	if neon.Get("defaultEffort") != "xhigh" {
		t.Fatalf("neon defaultEffort = %v, want xhigh from settings.json", neon.Get("defaultEffort"))
	}

	dm := sh.AsObj(cat.Get("defaultModel"))
	if dm == nil || dm.Get("id") != "gemini-4-neon" {
		t.Fatalf("defaultModel = %s, want gemini-4-neon", util.Stringify(dm))
	}

	// Single-variant suffixed model must NOT aggregate or invent a slider
	oss := findCatalogModel(t, cat, "gpt-oss-120b-medium")
	if oss == nil {
		t.Fatalf("missing gpt-oss-120b-medium")
	}
	if oss.Get("reasoning") != false || oss.Has("effortModels") {
		t.Fatalf("single suffixed model should not fake reasoning slider: %s", util.Stringify(oss))
	}
	if got := oss.Get("efforts"); !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("oss efforts = %#v, want empty", got)
	}

	// Orchestrator models stay intact without reasoning slider
	orch := findCatalogModel(t, cat, "gemini-pro-orchestrator-neon")
	if orch == nil || orch.Get("reasoning") != false {
		t.Fatalf("orchestrator entry mismatch: %s", util.Stringify(orch))
	}
}

func TestParseModelsACPPreservesAutoAndMetaEfforts(t *testing.T) {
	session := util.NewObj(
		"sessionId", "s-acp-1",
		"models", util.NewObj(
			"currentModelId", "auto",
			"availableModels", []any{
				util.NewObj("modelId", "auto", "name", "Auto", "description", "Automatic routing"),
				util.NewObj("modelId", "gemini-4-neon-medium", "name", "Gemini 4 Neon (Medium)"),
				util.NewObj("modelId", "gemini-4-neon-high", "name", "Gemini 4 Neon (High)"),
				util.NewObj("modelId", "claude-custom", "name", "Claude Custom", "_meta", util.NewObj("reasoningEfforts", []any{"low", "high"}, "reasoningEffort", "high")),
			},
		),
		"configOptions", []any{
			util.NewObj("id", "thought_level", "category", "thought_level", "currentValue", "medium", "options", []any{
				util.NewObj("value", "low"),
				util.NewObj("value", "medium"),
			}),
		},
	)
	cat := ParseModels(session)
	auto := findCatalogModel(t, cat, "auto")
	if auto == nil || auto.Get("reasoning") != false {
		t.Fatalf("auto must stay present without reasoning control even when configOptions exists: %s", util.Stringify(auto))
	}
	dm := sh.AsObj(cat.Get("defaultModel"))
	if dm == nil || dm.Get("id") != "auto" {
		t.Fatalf("defaultModel = %s, want auto", util.Stringify(dm))
	}
	custom := findCatalogModel(t, cat, "claude-custom")
	if custom == nil || custom.Get("reasoning") != true || custom.Get("defaultEffort") != "high" {
		t.Fatalf("meta reasoning model mismatch: %s", util.Stringify(custom))
	}
	if wm, we, cfg := ResolveModelAndEffort(cat, "gemini-4-neon", "high"); wm != "gemini-4-neon-high" || we != "" || cfg != "" {
		t.Fatalf("ResolveModelAndEffort aggregated = (%q, %q, %q)", wm, we, cfg)
	}
	if wm, we, cfg := ResolveModelAndEffort(cat, "auto", "high"); wm != "auto" || we != "" || cfg != "" {
		t.Fatalf("ResolveModelAndEffort auto = (%q, %q, %q), want no effort", wm, we, cfg)
	}
}

func TestResolveModelAndEffortAndArgs(t *testing.T) {
	cat := ParseModelsCLI(sampleAgyModels27, `{"model":"gemini-4-carbon-high"}`)

	// Default model when modelID == ""
	wm, we, cfg := ResolveModelAndEffort(cat, "", "low")
	if wm != "gemini-4-carbon-low" || we != "" || cfg != "" {
		t.Fatalf("default with effort override = (%q, %q, %q)", wm, we, cfg)
	}
	// Aggregated default when effort == "" falls back to model's defaultEffort ("high")
	wm, we, cfg = ResolveModelAndEffort(cat, "gemini-4-carbon", "")
	if wm != "gemini-4-carbon-high" || we != "" || cfg != "" {
		t.Fatalf("aggregated default effort = (%q, %q, %q)", wm, we, cfg)
	}
	// Single-variant suffixed model emits no effort
	wm, we, cfg = ResolveModelAndEffort(cat, "gpt-oss-120b-medium", "xhigh")
	if wm != "gpt-oss-120b-medium" || we != "" || cfg != "" {
		t.Fatalf("single variant = (%q, %q, %q)", wm, we, cfg)
	}

	args := ModelArgs(sh.ModelArgsIn{Model: " gemini-4-neon ", Effort: "xhigh"})
	if !reflect.DeepEqual(args, []string{"--model", "gemini-4-neon", "--effort", "xhigh"}) {
		t.Fatalf("ModelArgs = %#v", args)
	}
}
