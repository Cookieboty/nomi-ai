// Package anthropic ports @ai-sdk/anthropic's messages model
// (createAnthropic(...).messages(modelId)), used by Nomi for protocol
// "anthropic". Request bodies, headers, stream parts and errors match the
// Node SDK 4.0.78 (see testdata/b5-llm-anthropic.json goldens). Deviations
// are logged as D-B5-P-A-n in docs/design/migrate-2.0.5-go.md §3.4.
package anthropic

import (
	"net/http"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Version is @ai-sdk/anthropic VERSION.
const Version = "4.0.78"

// Settings is AnthropicProviderSettings (the subset Nomi passes).
type Settings struct {
	BaseURL string // "" = https://api.anthropic.com/v1
	APIKey  string // always sent as x-api-key (Nomi passes apiKey ?? '')
	Headers []llm.Header
	Client  *http.Client
}

// Provider is createAnthropic's result.
type Provider struct {
	s    Settings
	base string
}

func New(s Settings) *Provider {
	base := strings.TrimSuffix(s.BaseURL, "/")
	if s.BaseURL == "" {
		base = "https://api.anthropic.com/v1"
	}
	return &Provider{s: s, base: base}
}

// headers is the provider's getHeaders() (normalized, lowercase keys).
func (p *Provider) headers() []llm.Header {
	hs := []llm.Header{llm.H("anthropic-version", "2023-06-01"), llm.H("x-api-key", p.s.APIKey)}
	hs = append(hs, p.s.Headers...)
	return llm.WithUserAgentSuffix(hs, "ai-sdk-anthropic/"+Version)
}

// Messages is provider.messages(modelId) (provider name "anthropic.messages").
func (p *Provider) Messages(modelID string) llm.LanguageModel {
	return &MessagesModel{p: p, modelID: modelID, provider: "anthropic.messages"}
}

// MessagesModel is AnthropicLanguageModel.
type MessagesModel struct {
	p        *Provider
	modelID  string
	provider string
	// GenerateID overrides llm.GenerateID (tests).
	GenerateID func() string
}

func (m *MessagesModel) Provider() string { return m.provider }
func (m *MessagesModel) ModelID() string  { return m.modelID }

func (m *MessagesModel) genID() string {
	if m.GenerateID != nil {
		return m.GenerateID()
	}
	return llm.GenerateID()
}

func (m *MessagesModel) url() string { return m.p.base + "/messages" }

// betasFromHeaders is getBetasFromHeaders: config + call anthropic-beta,
// lowercased, split on ',', trimmed, empties dropped (insertion-ordered set).
func (m *MessagesModel) betasFromHeaders(call []llm.Header) []string {
	cfg, _ := llm.HeaderValue(m.p.headers(), "anthropic-beta")
	req, _ := llm.HeaderValue(call, "anthropic-beta")
	var out []string
	for _, s := range append(strings.Split(util.JSLower(cfg), ","), strings.Split(util.JSLower(req), ",")...) {
		if s = util.JSTrim(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// set is an insertion-ordered string set (JS Set<string>).
type set struct{ items []string }

func (s *set) add(v ...string) {
outer:
	for _, x := range v {
		for _, y := range s.items {
			if x == y {
				continue outer
			}
		}
		s.items = append(s.items, x)
	}
}
