// Package config mirrors packages/gateway/src/config.ts: the runtime snapshot
// the host builds from store.json (keys decrypted, memory only).
package config

import (
	"math"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CLIENT_IDS.
var ClientIDs = []string{"nomi", "claude", "codex", "gemini", "grok", "dsh"}

// RuntimeKey is RuntimeKey.
type RuntimeKey struct {
	ID             string   `json:"id"`
	Name           string   `json:"name,omitempty"`
	Value          string   `json:"value"`
	Wire           string   `json:"wire,omitempty"`
	Enabled        bool     `json:"enabled"`
	MaxConcurrency *float64 `json:"maxConcurrency,omitempty"`
	RPM            *float64 `json:"rpm,omitempty"`
}

// RuntimeModel is RuntimeModel.
type RuntimeModel struct {
	ID          string   `json:"id"`
	Enabled     bool     `json:"enabled"`
	Wires       []string `json:"wires,omitempty"`
	Ctx         *float64 `json:"ctx,omitempty"`
	MaxOutput   *float64 `json:"maxOutput,omitempty"`
	Reasoning   *bool    `json:"reasoning,omitempty"`
	Vision      *bool    `json:"vision,omitempty"`
	ToolCalling *bool    `json:"toolCalling,omitempty"`
	Label       *string  `json:"label,omitempty"`
	Efforts     []string `json:"efforts,omitempty"`
	Strict      *bool    `json:"strict,omitempty"`
}

// LearnedModel is LearnedModel.
type LearnedModel struct {
	At             float64  `json:"at"`
	CatalogVersion string   `json:"catalogVersion,omitempty"`
	Efforts        []string `json:"efforts,omitempty"`
	Temperature    *bool    `json:"temperature,omitempty"`
}

// ProbeState is ProbeState.
type ProbeState struct {
	OK   bool   `json:"ok"`
	Auth string `json:"auth,omitempty"`
}

// QuirkFixes is ProviderQuirks.fixes.
type QuirkFixes struct {
	ChatStream    *bool `json:"chatStream,omitempty"`
	TextToolCalls *bool `json:"textToolCalls,omitempty"`
	Repetition    *bool `json:"repetition,omitempty"`
	ToolNames     *bool `json:"toolNames,omitempty"`
}

// ProviderQuirks is ProviderQuirks.
type ProviderQuirks struct {
	ResponsesTellsCache *bool       `json:"responsesTellsCache,omitempty"`
	PreferWire          string      `json:"preferWire,omitempty"`
	MaxTools            *float64    `json:"maxTools,omitempty"`
	DropParams          []string    `json:"dropParams,omitempty"`
	ReasoningPassback   *bool       `json:"reasoningPassback,omitempty"`
	UserAgent           string      `json:"userAgent,omitempty"`
	MaxConcurrency      *float64    `json:"maxConcurrency,omitempty"`
	RPM                 *float64    `json:"rpm,omitempty"`
	ExtraBody           *u.Obj      `json:"extraBody,omitempty"` // wire → fields (ordered)
	Fixes               *QuirkFixes `json:"fixes,omitempty"`
	// Raw is the JS object these fields were read from (own keys in order, nulls
	// and "" included); nil for Go literals, which synthesise it (see quirks.go).
	Raw *u.Obj `json:"-"`
}

// ModelMapEntry is one modelMap row.
type ModelMapEntry struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// RuntimeProvider is RuntimeProvider.
type RuntimeProvider struct {
	ID        string                 `json:"id"`
	Aliases   []string               `json:"aliases,omitempty"`
	Name      string                 `json:"name"`
	Enabled   bool                   `json:"enabled"`
	URLs      *u.Obj                 `json:"urls"` // wire → base URL, JS key order
	Keys      []RuntimeKey           `json:"keys"`
	Models    []RuntimeModel         `json:"models"`
	Fallback  []string               `json:"fallback,omitempty"`
	Headers   *u.Obj                 `json:"headers,omitempty"`
	UserAgent *string                `json:"userAgent,omitempty"`
	ModelMap  []ModelMapEntry        `json:"modelMap,omitempty"`
	Detected  map[string]*ProbeState `json:"detected,omitempty"`
	Quirks    *ProviderQuirks        `json:"quirks,omitempty"`
	Preset    string                 `json:"preset,omitempty"`
	Spec      string                 `json:"spec,omitempty"`

	memo *sync.Map // effectiveModel cache (the WeakMap keyed by provider object)
}

var memoMu sync.Mutex

// Memo is the per-provider-object cache (WeakMap<RuntimeProvider, …> in Node).
func (p *RuntimeProvider) Memo() *sync.Map {
	memoMu.Lock()
	defer memoMu.Unlock()
	if p.memo == nil {
		p.memo = &sync.Map{}
	}
	return p.memo
}

// ClientModels is ClientModels.
type ClientModels struct {
	Main     *string           `json:"main,omitempty"`
	Small    *string           `json:"small,omitempty"`
	Tiers    map[string]string `json:"tiers,omitempty"`
	Subagent *string           `json:"subagent,omitempty"`
	Tools    *string           `json:"tools,omitempty"`
	Summary  *string           `json:"summary,omitempty"`
}

// ClientRuntime is ClientRuntime.
type ClientRuntime struct {
	Token  string       `json:"token"`
	Models ClientModels `json:"models"`
}

// WireDown is one wireDown entry.
type WireDown struct {
	At     float64 `json:"at"`
	Reason string  `json:"reason"`
}

// LearnedState is LearnedState.
type LearnedState struct {
	WireDown           map[string]WireDown     `json:"wireDown,omitempty"`
	ModelWire          map[string][]string     `json:"modelWire,omitempty"`
	DroppedParams      map[string][]string     `json:"droppedParams,omitempty"`
	CustomToolsRefused []string                `json:"customToolsRefused,omitempty"`
	Models             map[string]LearnedModel `json:"models,omitempty"`
}

// Body size limits.
const (
	DefaultMaxRequestBodyBytes = 32 * 1024 * 1024
	MinMaxRequestBodyBytes     = 1 * 1024 * 1024
	MaxMaxRequestBodyBytes     = 256 * 1024 * 1024
)

// ClampMaxRequestBodyBytes is clampMaxRequestBodyBytes (nil = not a number).
func ClampMaxRequestBodyBytes(n *float64) int {
	if n == nil || math.IsInf(*n, 0) || math.IsNaN(*n) {
		return DefaultMaxRequestBodyBytes
	}
	return int(math.Min(MaxMaxRequestBodyBytes, math.Max(MinMaxRequestBodyBytes, math.Floor(*n))))
}

// KnownSecret is PrivacyConfig.known[].
type KnownSecret struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

// PrivacyConfig is PrivacyConfig.
type PrivacyConfig struct {
	Enabled bool              `json:"enabled"`
	Strict  bool              `json:"strict,omitempty"`
	Local   bool              `json:"local,omitempty"`
	Shape   bool              `json:"shape,omitempty"`
	Key     string            `json:"key"`
	Known   []KnownSecret     `json:"known,omitempty"`
	Actions map[string]string `json:"actions,omitempty"`
	Allow   []string          `json:"allow,omitempty"`
}

// GatewayConfig is GatewayConfig.
type GatewayConfig struct {
	Host                string                    `json:"host"`
	Port                int                       `json:"port"`
	Providers           []RuntimeProvider         `json:"providers"`
	Clients             map[string]*ClientRuntime `json:"clients"`
	LegacyToken         string                    `json:"legacyToken,omitempty"`
	AllowedPrivateHosts []string                  `json:"allowedPrivateHosts,omitempty"`
	Learned             map[string]*LearnedState  `json:"learned,omitempty"`
	SessionsFile        string                    `json:"sessionsFile,omitempty"`
	CatalogFile         string                    `json:"catalogFile,omitempty"`
	TraceDir            string                    `json:"traceDir,omitempty"`
	StrictParams        bool                      `json:"strictParams,omitempty"`
	MaxRequestBodyBytes *float64                  `json:"maxRequestBodyBytes,omitempty"`
	RoutePlan           string                    `json:"routePlan,omitempty"`
	Privacy             *PrivacyConfig            `json:"privacy,omitempty"`
}

// URL is p.urls[wire] ("" when unset or not a string).
func (p *RuntimeProvider) URL(wire string) string {
	if p.URLs == nil {
		return ""
	}
	return u.Str(p.URLs.Get(wire))
}

// URLWires is Object.keys(p.urls).
func (p *RuntimeProvider) URLWires() []string {
	if p.URLs == nil {
		return nil
	}
	return p.URLs.Keys()
}

// Model is p.models.find(m => m.id === id).
func (p *RuntimeProvider) Model(id string) *RuntimeModel {
	for i := range p.Models {
		if p.Models[i].ID == id {
			return &p.Models[i]
		}
	}
	return nil
}
