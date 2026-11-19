package route

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestAdaptiveRectifierUpgradesLegacyThinking(t *testing.T) {
	errMsg := "status_code=400, claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort"
	sent := u.NewObj(
		"model", "claude-opus-5-5",
		"max_tokens", 32000.0,
		"temperature", 0.7,
		"top_k", 40.0,
		"top_p", 0.9,
		"thinking", u.NewObj("type", "enabled", "budget_tokens", 16000.0),
	)
	rec := RectifierForBeta(400, errMsg, sent, false)
	if rec == nil || rec.Fix != "adaptive" {
		t.Fatalf("RectifierForBeta=%+v, want adaptive", rec)
	}
	var notes []string
	fixed := ApplyRectifiers("messages", sent, []string{rec.Fix}, nil, &notes)
	s := u.Stringify(fixed)
	if !strings.Contains(s, `"thinking":{"type":"adaptive"}`) {
		t.Fatalf("missing adaptive thinking: %s", s)
	}
	if !strings.Contains(s, `"output_config":{"effort":"medium"}`) {
		t.Fatalf("expected mapped output_config.effort=medium: %s", s)
	}
	for _, drop := range []string{`"budget_tokens"`, `"temperature"`, `"top_k"`, `"top_p"`} {
		if strings.Contains(s, drop) {
			t.Fatalf("unexpected %s in %s", drop, s)
		}
	}

	disabled := u.NewObj("model", "claude-opus-5-5", "thinking", u.NewObj("type", "disabled"))
	rec2 := RectifierForBeta(400, errMsg, disabled, false)
	if rec2 == nil || rec2.Fix != "adaptive" {
		t.Fatalf("disabled RectifierForBeta=%+v, want adaptive", rec2)
	}
	fixed2 := ApplyRectifiers("messages", disabled, []string{rec2.Fix}, nil, &notes)
	if s2 := u.Stringify(fixed2); strings.Contains(s2, `"thinking"`) {
		t.Fatalf("disabled should omit thinking: %s", s2)
	}
}
