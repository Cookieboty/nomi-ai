// Package route mirrors packages/gateway/src/route/*.
package route

import (
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// DefaultOrder is DEFAULT_ORDER.
var DefaultOrder = []string{"chat", "responses", "messages", "gemini"}

func bare(model string) string {
	if i := strings.LastIndex(model, "/"); i >= 0 {
		model = model[i+1:]
	}
	return u.JSLower(model)
}

// IsClaudeModel is isClaudeModel.
func IsClaudeModel(model string) bool { return strings.HasPrefix(bare(model), "claude") }

var openaiRe = regexp.MustCompile(`^(gpt-|codex|o[0-9])`)

// IsOpenAIModel is isOpenAIModel.
func IsOpenAIModel(model string) bool { return openaiRe.MatchString(bare(model)) }

// WireDownTTLMs is WIRE_DOWN_TTL_MS.
const WireDownTTLMs = 60 * 60_000

func has(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// NowMs is Date.now().
func NowMs() float64 { return float64(time.Now().UnixMilli()) }

// WiresFor is wiresFor (key/learned nil = undefined).
func WiresFor(p *config.RuntimeProvider, model string, key *config.RuntimeKey, learned *config.LearnedState, now float64) []string {
	m := p.Model(model)
	var learnedModel []string
	if learned != nil {
		learnedModel = learned.ModelWire[model]
	}
	out := []string{}
	for _, w := range p.URLWires() {
		if !u.Truthy(p.URLs.Get(w)) {
			continue
		}
		if d := p.Detected[w]; d != nil && !d.OK {
			continue
		}
		if m != nil && len(m.Wires) > 0 && !has(m.Wires, w) {
			continue
		}
		if len(learnedModel) > 0 && !has(learnedModel, w) {
			continue
		}
		if key != nil && key.Wire != "" && key.Wire != w {
			continue
		}
		if learned != nil {
			if down, ok := learned.WireDown[w]; ok && now-down.At < WireDownTTLMs {
				continue
			}
		}
		out = append(out, w)
	}
	return out
}

// PickWire is pickWire (ingress "" = null; result "" = null).
func PickWire(p *config.RuntimeProvider, model, ingress string, usable []string) string {
	if len(usable) == 0 {
		return ""
	}
	m := p.Model(model)
	manual := m != nil && len(m.Wires) > 0
	if !manual && IsClaudeModel(model) && has(usable, "messages") {
		return "messages"
	}
	if ingress != "" && has(usable, ingress) {
		return ingress
	}
	if IsOpenAIModel(model) && has(usable, "responses") {
		return "responses"
	}
	q := providers.QuirksOf(p, "")
	if q.ResponsesTellsCache != nil && *q.ResponsesTellsCache && has(usable, "responses") {
		return "responses"
	}
	if q.PreferWire != "" && has(usable, q.PreferWire) {
		return q.PreferWire
	}
	for _, w := range DefaultOrder {
		if has(usable, w) {
			return w
		}
	}
	return ""
}
