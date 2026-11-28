package shared

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestParseAcpSessionModelsStandardAndConfigOptions(t *testing.T) {
	session := util.NewObj(
		"sessionId", "s1",
		"models", util.NewObj(
			"currentModelId", "kimi-k2.5",
			"availableModels", []any{
				util.NewObj("modelId", "kimi-k2.5", "name", "Kimi K2.5", "description", "flagship"),
				util.NewObj("modelId", "kimi-k2-thinking", "name", "Kimi K2 Thinking", "_meta", util.NewObj(
					"reasoningEfforts", []any{"low", "high"},
					"reasoningEffort", "high",
				)),
			},
		),
		"configOptions", []any{
			util.NewObj(
				"id", "thought_level",
				"category", "thought_level",
				"currentValue", "medium",
				"options", []any{
					util.NewObj("value", "low"),
					util.NewObj("value", "medium"),
					util.NewObj("value", "high"),
				},
			),
		},
		"modes", util.NewObj("availableModes", []any{
			util.NewObj("id", "default"),
			util.NewObj("id", "plan"),
		}),
	)

	cat := ParseAcpSessionModels("kimi", session)
	if cat.Get("backend") != "kimi" {
		t.Fatalf("backend = %v, want kimi", cat.Get("backend"))
	}
	if cat.Get("effortConfigId") != "thought_level" {
		t.Fatalf("effortConfigId = %v, want thought_level", cat.Get("effortConfigId"))
	}
	def := AsObj(cat.Get("defaultModel"))
	if def.Get("id") != "kimi-k2.5" || def.Get("defaultEffort") != "medium" {
		t.Fatalf("defaultModel = %s", util.Stringify(def))
	}
	models, _ := cat.Get("models").([]any)
	if len(models) != 2 {
		t.Fatalf("len(models) = %d, want 2", len(models))
	}
	m1 := AsObj(models[1])
	if m1.Get("defaultEffort") != "high" {
		t.Fatalf("item-level defaultEffort = %v, want high", m1.Get("defaultEffort"))
	}

	ov := ResolveAcpModelOverride(cat, "kimi-k2.5", "")
	if ov.ModelID != "kimi-k2.5" || ov.Effort != "medium" || ov.EffortConfigID != "thought_level" {
		t.Fatalf("ResolveAcpModelOverride = %+v", ov)
	}
	ovDefault := ResolveAcpModelOverride(cat, "cli-default", "high")
	if ovDefault.ModelID != "" || ovDefault.Effort != "high" || ovDefault.EffortConfigID != "thought_level" {
		t.Fatalf("ResolveAcpModelOverride(cli-default) = %+v", ovDefault)
	}
}

func TestParseAcpSessionModelsConfigOnlyFallback(t *testing.T) {
	session := util.NewObj(
		"sessionId", "s2",
		"configOptions", []any{
			util.NewObj(
				"id", "model",
				"category", "model",
				"currentValue", "minimax-m2",
				"options", []any{
					util.NewObj("value", "minimax-m2", "name", "MiniMax M2"),
				},
			),
		},
	)
	cat := ParseAcpSessionModels("minimax", session)
	def := AsObj(cat.Get("defaultModel"))
	if def.Get("id") != "minimax-m2" {
		t.Fatalf("defaultModel = %s", util.Stringify(def))
	}
	ov := ResolveAcpModelOverride(cat, "minimax-m2", "high")
	if ov.ModelID != "minimax-m2" || ov.Effort != "" {
		t.Fatalf("non-reasoning model should strip effort, got %+v", ov)
	}
}
