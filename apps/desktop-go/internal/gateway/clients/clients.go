// Package clients mirrors packages/gateway/src/clients/* plus the plugin
// client specs the host registers at startup (core/src/gateway/pluginSpecs.ts
// with @nomi-ai/cli-plugins BUILTIN_GATEWAY_ENTRIES).
package clients

import (
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/spec"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// SessionKeyRule is SessionKeyRule.
type SessionKeyRule struct {
	Header   string
	BodyPath string
	Parse    string // "" | "claude-user"
	Prefix   string
}

// BuiltinModelRule is BuiltinModelRule.
type BuiltinModelRule struct {
	Pattern string
	Slot    string
}

// Legacy is ClientSpec.legacy.
type Legacy struct {
	Ingress   string
	UserAgent string
}

// Spec is ClientSpec.
type Spec struct {
	ID         string
	Strictness string // strict | lenient
	// ExtraRequired: event type → ordered field → default.
	ExtraRequired *u.Obj
	// AcceptedEvents: nil = no filter; AcceptSpec = the wire's spec table.
	AcceptedEvents       []string
	AcceptSpec           bool
	HelperModels         []string
	SubagentModels       []string
	BuiltinModels        []BuiltinModelRule
	UnknownToMain        bool
	SessionKey           []SessionKeyRule
	Heartbeat            string // "" = undefined
	Legacy               *Legacy
	SynthesizedReasoning []string
}

// Hooks is ClientAdapterHooks.
type Hooks struct {
	Request func(body any, spec *Spec, wire string) any
	Conform func(ev *sse.Event, ctx *ConformContext) *sse.Event
}

// ConformContext is ConformContext.
type ConformContext struct {
	Spec  *Spec
	Wire  string
	Notes *[]string
}

// DefaultSessionKey is DEFAULT_SESSION_KEY.
var DefaultSessionKey = []SessionKeyRule{
	{BodyPath: "prompt_cache_key", Prefix: "pck"},
	{Header: "x-claude-code-session-id", Prefix: "cc"},
	{BodyPath: "metadata.user_id", Parse: "claude-user", Prefix: "cc"},
}

// Nomi is the built-in nomi spec.
var Nomi = &Spec{ID: "nomi", Strictness: "lenient", SessionKey: DefaultSessionKey, Heartbeat: "comment"}

const claudeGate = "(?:claude|^(?:opus|sonnet|haiku|fable|default)$)"

func tier(t string) BuiltinModelRule {
	return BuiltinModelRule{Pattern: "^(?=.*" + claudeGate + ").*" + t, Slot: "tiers." + t}
}

// PluginSpecs are BUILTIN_GATEWAY_ENTRIES' client specs, in registration order.
var PluginSpecs = []*Spec{
	{ID: "claude", Strictness: "lenient", BuiltinModels: []BuiltinModelRule{tier("opus"), tier("sonnet"), tier("haiku"), tier("fable"), {Pattern: claudeGate, Slot: "main"}},
		SessionKey: DefaultSessionKey, Heartbeat: "ping", Legacy: &Legacy{Ingress: "messages"}, SynthesizedReasoning: []string{"thinking.budget_tokens"}},
	{ID: "codex", Strictness: "lenient", UnknownToMain: true, SessionKey: DefaultSessionKey, Heartbeat: "comment", Legacy: &Legacy{UserAgent: "codex"}},
	{ID: "grok", Strictness: "strict", AcceptSpec: true, HelperModels: []string{`^grok-4\.6`}, BuiltinModels: []BuiltinModelRule{{Pattern: "^nomi$", Slot: "main"}},
		UnknownToMain: true, SessionKey: DefaultSessionKey, Heartbeat: "comment", Legacy: &Legacy{UserAgent: "grok"}},
	{ID: "dsh", Strictness: "lenient", UnknownToMain: true, SessionKey: DefaultSessionKey, Heartbeat: "comment", Legacy: &Legacy{UserAgent: "dsh"}},
	{ID: "gemini", Strictness: "lenient", UnknownToMain: true, SessionKey: DefaultSessionKey, Heartbeat: "comment", Legacy: &Legacy{Ingress: "gemini"}},
}

var (
	mu    sync.RWMutex
	order []string
	specs = map[string]*Spec{}
	hooks = map[string]*Hooks{}
)

func init() {
	RegisterClientSpec(Nomi, nil)
	RegisterPluginClientSpecs()
}

// RegisterPluginClientSpecs is registerPluginClientSpecs(BUILTIN_GATEWAY_ENTRIES).
func RegisterPluginClientSpecs() []string {
	ids := []string{}
	for _, s := range PluginSpecs {
		RegisterClientSpec(s, nil)
		ids = append(ids, s.ID)
	}
	return ids
}

// RegisterClientSpec is registerClientSpec (Map.set keeps the first position).
func RegisterClientSpec(s *Spec, h *Hooks) {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := specs[s.ID]; !ok {
		order = append(order, s.ID)
	}
	specs[s.ID] = s
	if h != nil {
		hooks[s.ID] = h
	} else {
		delete(hooks, s.ID)
	}
}

// ClientSpecOf is clientSpecOf (nil = undefined).
func ClientSpecOf(id string) *Spec {
	if id == "" {
		return nil
	}
	mu.RLock()
	defer mu.RUnlock()
	return specs[id]
}

// ClientHooksOf is clientHooksOf.
func ClientHooksOf(id string) *Hooks {
	if id == "" {
		return nil
	}
	mu.RLock()
	defer mu.RUnlock()
	return hooks[id]
}

// RegisteredClientIDs is registeredClientIds.
func RegisteredClientIDs() []string {
	mu.RLock()
	defer mu.RUnlock()
	return append([]string(nil), order...)
}

func specEvents(wire string) map[string]bool {
	switch wire {
	case "responses":
		return spec.ResponsesEvents
	case "messages":
		return spec.MessagesEvents
	}
	return nil
}

// LegacyClientOf is legacyClientOf ("" = null; ingress "" = null).
func LegacyClientOf(ingress, userAgent string) string {
	ua := u.JSLower(userAgent)
	mu.RLock()
	defer mu.RUnlock()
	for _, id := range order {
		l := specs[id].Legacy
		if l == nil {
			continue
		}
		if l.Ingress != "" && ingress == l.Ingress {
			return id
		}
		if l.UserAgent != "" && strings.Contains(ua, u.JSLower(l.UserAgent)) {
			return id
		}
	}
	return ""
}

// SessionKeyRules is sessionKeyRules.
func SessionKeyRules(client string) []SessionKeyRule {
	if s := ClientSpecOf(client); s != nil && s.SessionKey != nil {
		return s.SessionKey
	}
	return DefaultSessionKey
}

// SlotModel is slotModel (nil = undefined).
func SlotModel(m *config.ClientModels, slot string) *string {
	if slot == "main" {
		return m.Main
	}
	if t, ok := strings.CutPrefix(slot, "tiers."); ok {
		if v, ok := m.Tiers[t]; ok {
			return &v
		}
		if t == "haiku" && m.Small != nil {
			return m.Small
		}
		return m.Main
	}
	var v *string
	switch slot {
	case "small":
		v = m.Small
	case "summary":
		v = m.Summary
	case "subagent":
		v = m.Subagent
	case "tools":
		v = m.Tools
	}
	if v != nil {
		return v
	}
	return m.Main
}

// SlotIsSet is slotIsSet.
func SlotIsSet(m *config.ClientModels, slot string) bool {
	nz := func(p *string) bool { return p != nil && *p != "" }
	if slot == "main" {
		return nz(m.Main)
	}
	if t, ok := strings.CutPrefix(slot, "tiers."); ok {
		if v, ok := m.Tiers[t]; ok {
			return v != ""
		}
		return t == "haiku" && nz(m.Small)
	}
	switch slot {
	case "small":
		return nz(m.Small)
	case "summary":
		return nz(m.Summary)
	case "subagent":
		return nz(m.Subagent)
	case "tools":
		return nz(m.Tools)
	}
	return false
}

func test(patterns []string, name string) bool {
	for _, p := range patterns {
		if u.CompileJSI(p).Test(name) {
			return true
		}
	}
	return false
}

// SlotHit is builtinSlot's result.
type SlotHit struct{ Slot, How string }

// BuiltinSlot is builtinSlot (nil = not recognised).
func BuiltinSlot(s *Spec, requested string) *SlotHit {
	for _, r := range s.BuiltinModels {
		if u.CompileJSI(r.Pattern).Test(requested) {
			how := "tier"
			if r.Slot == "main" {
				how = "default"
			}
			return &SlotHit{r.Slot, how}
		}
	}
	if test(s.HelperModels, requested) {
		return &SlotHit{"summary", "helper"}
	}
	if test(s.SubagentModels, requested) {
		return &SlotHit{"subagent", "subagent"}
	}
	return nil
}
