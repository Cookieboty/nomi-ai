package models

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type ref struct {
	id, label   string
	ctx, maxOut *float64
}

func refs(cfg *config.GatewayConfig) []ref {
	var out []ref
	for i := range cfg.Providers {
		p := &cfg.Providers[i]
		if !p.Enabled {
			continue
		}
		for _, m := range p.Models {
			if !m.Enabled {
				continue
			}
			label := m.ID
			if m.Label != nil {
				label = *m.Label
			}
			out = append(out, ref{id: p.ID + "/" + m.ID, label: p.Name + " / " + label, ctx: m.Ctx, maxOut: m.MaxOutput})
		}
	}
	return out
}

// ModelsBody is modelsBody (format: openai | anthropic | gemini).
func ModelsBody(cfg *config.GatewayConfig, format string) *u.Obj {
	list := refs(cfg)
	data := []any{}
	switch format {
	case "anthropic":
		for _, m := range list {
			data = append(data, u.NewObj("type", "model", "id", m.id, "display_name", m.label, "created_at", "1970-01-01T00:00:00Z"))
		}
		var first, last any
		if len(list) > 0 {
			first, last = list[0].id, list[len(list)-1].id
		}
		return u.NewObj("data", data, "has_more", false, "first_id", first, "last_id", last)
	case "gemini":
		for _, m := range list {
			o := u.NewObj("name", "models/"+m.id, "baseModelId", m.id, "displayName", m.label)
			if m.ctx != nil && *m.ctx != 0 {
				o.Set("inputTokenLimit", *m.ctx)
			}
			if m.maxOut != nil && *m.maxOut != 0 {
				o.Set("outputTokenLimit", *m.maxOut)
			}
			o.Set("supportedGenerationMethods", []any{"generateContent", "streamGenerateContent", "countTokens"})
			data = append(data, o)
		}
		return u.NewObj("models", data)
	}
	for _, m := range list {
		data = append(data, u.NewObj("id", m.id, "object", "model", "created", 0.0, "owned_by", strings.SplitN(m.id, "/", 2)[0]))
	}
	return u.NewObj("object", "list", "data", data)
}
