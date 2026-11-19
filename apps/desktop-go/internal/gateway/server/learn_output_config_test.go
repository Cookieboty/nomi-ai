package server

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestClassifyAndLearnUnsupportedOutputConfig(t *testing.T) {
	sent := u.NewObj("model", "claude-opus-5-5", "output_config", u.NewObj("effort", "high"))
	f := ClassifyFailure(400, "unknown field output_config", sent, nil)
	if f.Kind != "param" || f.Param != "output_config" {
		t.Fatalf("ClassifyFailure=%+v, want param output_config", f)
	}
	var events []LearnEvent
	l := NewLearner(func(e LearnEvent) { events = append(events, e) }, nil)
	c := &cand.Candidate{
		Provider:    &config.RuntimeProvider{ID: "relay"},
		Key:         &config.RuntimeKey{ID: "k1"},
		PublicModel: "relay/claude-opus-5-5",
		Wire:        "messages",
	}
	r := l.Failure(c, f)
	if r == nil || r.DropParam != "output_config" {
		t.Fatalf("Failure retry=%+v, want DropParam=output_config", r)
	}
	if len(events) != 1 || events[0].Type != "dropped-param" || events[0].Param != "output_config" {
		t.Fatalf("events=%+v", events)
	}
}
