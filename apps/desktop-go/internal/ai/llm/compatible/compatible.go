// Package compatible ports @ai-sdk/openai-compatible's chat model
// (createOpenAICompatible(...).chatModel), used by Nomi for protocol
// "openai-chat". Request bodies, headers, stream parts and errors match the
// Node SDK (see testdata/b5-llm.json goldens).
package compatible

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Version is @ai-sdk/openai-compatible VERSION.
const Version = "3.0.67"

// Settings is OpenAICompatibleProviderSettings.
type Settings struct {
	Name         string
	BaseURL      string
	APIKey       string // "" = no Authorization header
	Headers      []llm.Header
	QueryParams  [][2]string
	IncludeUsage bool
	Client       *http.Client
}

// Provider is createOpenAICompatible's result.
type Provider struct{ s Settings }

func New(s Settings) *Provider { return &Provider{s} }

func (p *Provider) headers() []llm.Header {
	var hs []llm.Header
	if p.s.APIKey != "" {
		hs = append(hs, llm.H("Authorization", "Bearer "+p.s.APIKey))
	}
	hs = llm.CombineHeaders(hs, p.s.Headers)
	return llm.WithUserAgentSuffix(hs, "ai-sdk-openai-compatible/"+Version)
}

func (p *Provider) url(path string) string {
	base := strings.TrimSuffix(p.s.BaseURL, "/")
	raw := base + path
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if p.s.QueryParams != nil {
		q := make([]string, 0, len(p.s.QueryParams))
		for _, kv := range p.s.QueryParams {
			q = append(q, url.QueryEscape(kv[0])+"="+url.QueryEscape(kv[1]))
		}
		u.RawQuery = strings.Join(q, "&")
	}
	return u.String()
}

// ChatModel is provider.chatModel(modelId).
func (p *Provider) ChatModel(modelID string) llm.LanguageModel {
	return &ChatModel{p: p, modelID: modelID, provider: p.s.Name + ".chat"}
}

// ChatModel is OpenAICompatibleChatLanguageModel.
type ChatModel struct {
	p        *Provider
	modelID  string
	provider string
	// GenerateID overrides llm.GenerateID (tests).
	GenerateID func() string
}

func (m *ChatModel) Provider() string { return m.provider }
func (m *ChatModel) ModelID() string  { return m.modelID }

func (m *ChatModel) genID() string {
	if m.GenerateID != nil {
		return m.GenerateID()
	}
	return llm.GenerateID()
}

func (m *ChatModel) optionsName() string {
	return util.JSTrim(strings.SplitN(m.provider, ".", 2)[0])
}

var failedHandler = llm.JSONErrorHandler(errorSchema, func(d any) string {
	return d.(*util.Obj).Get("error").(*util.Obj).Get("message").(string)
}, nil)

var _ = context.Background
