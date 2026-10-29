package agents

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// Kinds = AgentKind 的固定顺序（settings.tools 键序）。
var Kinds = []AgentKind{"codex", "claude", "dsh", "grok", "gemini"}

// Settings mirrors AgentWatchSettings。
type Settings struct {
	Enabled        bool
	StallMs        float64
	CooldownMs     float64
	SummaryEnabled bool
	Tools          map[AgentKind]bool
}

// DefaultAgentWatch mirrors DEFAULT_AGENT_WATCH。
func DefaultAgentWatch() Settings {
	return Settings{Enabled: true, StallMs: 5 * 60_000, CooldownMs: 90_000,
		Tools: map[AgentKind]bool{"codex": true, "claude": true, "dsh": true, "grok": true, "gemini": true}}
}

func (s Settings) toolsObj() *util.Obj {
	o := util.NewObj()
	for _, k := range Kinds {
		o.Set(k, s.Tools[k])
	}
	return o
}

// Obj = 设置的 JSON 形状（键序同 sanitizeAgentWatch 的返回）。
func (s Settings) Obj() *util.Obj {
	return util.NewObj("enabled", s.Enabled, "stallMs", s.StallMs, "cooldownMs", s.CooldownMs,
		"summaryEnabled", s.SummaryEnabled, "tools", s.toolsObj())
}

// SanitizeAgentWatch mirrors sanitizeAgentWatch(raw, base)。
func SanitizeAgentWatch(raw any, base Settings) Settings {
	o := util.AsObj(raw)
	if o == nil {
		o = util.NewObj()
	}
	tools := base.toolsObj()
	if t := util.AsObj(o.Get("tools")); t != nil {
		for _, k := range t.Keys() {
			tools.Set(k, t.Get(k))
		}
	}
	b := func(v any, d bool) bool {
		if x, ok := v.(bool); ok {
			return x
		}
		return d
	}
	n := func(v any, d float64) float64 {
		if x, ok := v.(float64); ok && x > 0 {
			return x
		}
		return d
	}
	out := Settings{
		Enabled:        b(o.Get("enabled"), base.Enabled),
		StallMs:        n(o.Get("stallMs"), base.StallMs),
		CooldownMs:     n(o.Get("cooldownMs"), base.CooldownMs),
		SummaryEnabled: b(o.Get("summaryEnabled"), base.SummaryEnabled),
		Tools:          map[AgentKind]bool{},
	}
	for _, k := range Kinds {
		out.Tools[k] = b(tools.Get(k), true)
	}
	return out
}
