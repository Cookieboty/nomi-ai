package upstream

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sp(s string) *string   { return &s }
func fp(f float64) *float64 { return &f }

func relay(ms ...config.RuntimeModel) *config.RuntimeProvider {
	return &config.RuntimeProvider{ID: "maas", Name: "MAAS", Enabled: true,
		URLs: u.NewObj("messages", "https://relay.example"),
		Keys: []config.RuntimeKey{{ID: "k1", Value: "sk-test-1", Enabled: true}}, Models: ms}
}

func candOf(p *config.RuntimeProvider, model, wire string, rectify ...string) *cand.Candidate {
	return &cand.Candidate{Provider: p, Key: &p.Keys[0], PublicModel: p.ID + "/" + model, UpstreamModel: model,
		Wire: wire, Model: models.EffectiveModel(p, model, nil, models.EffectiveOpts{}), Rectify: rectify}
}

// like：族默认与目录按它查
func TestLikeEffectiveModel(t *testing.T) {
	p := relay(
		config.RuntimeModel{ID: "Aerith-opus-5.5", Enabled: true, Like: sp("claude-opus-4-8")},
		config.RuntimeModel{ID: "Aerith-opus-small", Enabled: true, Like: sp("claude-opus-4-8"), Ctx: fp(300_000)},
		config.RuntimeModel{ID: "Aerith-unknown", Enabled: true},
	)
	ctxOf := func(id string) any {
		lim, _ := models.EffectiveModel(p, id, nil, models.EffectiveOpts{}).Get("limits").(*u.Obj)
		if lim == nil {
			return nil
		}
		return lim.Get("context")
	}
	if v := ctxOf("Aerith-opus-5.5"); v != 1_000_000.0 {
		t.Fatalf("like context %v", v)
	}
	if v := ctxOf("Aerith-opus-small"); v != 300_000.0 {
		t.Fatalf("user ctx should win: %v", v)
	}
	if v := ctxOf("Aerith-unknown"); v != nil && v != u.Undefined {
		t.Fatalf("unknown model context %v", v)
	}
}

func TestContext1mBeta(t *testing.T) {
	p := relay(
		config.RuntimeModel{ID: "big", Enabled: true, Like: sp("claude-opus-4-8")},
		config.RuntimeModel{ID: "small", Enabled: true, Like: sp("claude-opus-4-8"), Ctx: fp(200_000)},
		config.RuntimeModel{ID: "gpt", Enabled: true, Like: sp("gpt-5"), Ctx: fp(1_000_000)},
	)
	beta := func(c *cand.Candidate, client string) any {
		ch := map[string]any{}
		if client != "" {
			ch["anthropic-beta"] = client
		}
		return Headers(c, HeaderOpts{Stream: true, ClientHeaders: ch, SameWire: true}).Get("anthropic-beta")
	}
	if !WantsContext1m(candOf(p, "big", "messages")) || beta(candOf(p, "big", "messages"), "") != route.Context1mBeta {
		t.Fatal("big claude model should get context-1m")
	}
	if got := beta(candOf(p, "big", "messages"), "fine-grained-tool-streaming-2025-05-14"); got != "fine-grained-tool-streaming-2025-05-14,"+route.Context1mBeta {
		t.Fatalf("merge client beta: %v", got)
	}
	for name, c := range map[string]*cand.Candidate{
		"small":   candOf(p, "small", "messages"),
		"gpt":     candOf(p, "gpt", "messages"),
		"chat":    candOf(p, "big", "chat"),
		"refused": candOf(p, "big", "messages", "beta"),
	} {
		if WantsContext1m(c) {
			t.Fatalf("%s should not get context-1m", name)
		}
	}
	text := "Unexpected value(s) `context-1m-2025-08-07` for the `anthropic-beta` header"
	if r := route.RectifierForBeta(400, text, nil, true); r == nil || r.Fix != "beta" {
		t.Fatalf("beta rectifier %+v", r)
	}
	if r := route.RectifierForBeta(400, text, nil, false); r != nil {
		t.Fatalf("no beta sent, should not rectify: %+v", r)
	}
}
