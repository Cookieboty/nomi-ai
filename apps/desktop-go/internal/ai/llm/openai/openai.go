// Package openai ports @ai-sdk/openai's Responses API language model
// (createOpenAI(...).responses(modelId)), used by Nomi for protocol
// "openai-responses". It is a self-contained net/http + SSE adapter (no
// vendor SDK): request bodies, headers, stream parts and errors match the
// Node SDK (see testdata/b5-llm-openai-responses.json goldens).
//
// Scope (docs/design/migrate-2.0.5-go.md D-B5-P-7): function tools and the
// message / reasoning / function_call output items. Provider-executed tools
// (web/file search, code interpreter, shell, MCP, …), conversations,
// compaction and GPT-6 configuration updates are not ported.
package openai

import (
	"net/http"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Version is @ai-sdk/openai VERSION.
const Version = "4.0.91"

// Settings is OpenAIProviderSettings (the subset Nomi passes).
type Settings struct {
	// Name is the provider name (Nomi passes the provider entry id).
	Name         string
	BaseURL      string
	APIKey       string
	Organization string
	Project      string
	Headers      []llm.Header
	Client       *http.Client
}

// Provider is createOpenAI's result.
type Provider struct{ s Settings }

func New(s Settings) *Provider { return &Provider{s} }

func (p *Provider) name() string {
	if p.s.Name == "" {
		return "openai"
	}
	return p.s.Name
}

func (p *Provider) baseURL() string {
	b := p.s.BaseURL
	if b == "" {
		b = "https://api.openai.com/v1"
	}
	return strings.TrimSuffix(b, "/") // withoutTrailingSlash
}

// headers is getHeaders: loadApiKey (a string apiKey is used verbatim).
func (p *Provider) headers() []llm.Header {
	hs := []llm.Header{llm.H("Authorization", "Bearer "+p.s.APIKey)}
	if p.s.Organization != "" {
		hs = append(hs, llm.H("OpenAI-Organization", p.s.Organization))
	} else {
		hs = append(hs, llm.Header{Name: "OpenAI-Organization", Undefined: true})
	}
	if p.s.Project != "" {
		hs = append(hs, llm.H("OpenAI-Project", p.s.Project))
	} else {
		hs = append(hs, llm.Header{Name: "OpenAI-Project", Undefined: true})
	}
	hs = llm.CombineHeaders(hs, p.s.Headers)
	return llm.WithUserAgentSuffix(hs, "ai-sdk-openai/"+Version)
}

// Responses is provider.responses(modelId).
func (p *Provider) Responses(modelID string) *ResponsesModel {
	return &ResponsesModel{p: p, modelID: modelID, provider: p.name() + ".responses",
		fileIDPrefixes: []string{"file-"}}
}

// ResponsesModel is OpenAIResponsesLanguageModel.
type ResponsesModel struct {
	p              *Provider
	modelID        string
	provider       string
	fileIDPrefixes []string
	// GenerateID overrides llm.GenerateID (tests).
	GenerateID func() string
}

var _ llm.LanguageModel = (*ResponsesModel)(nil)

func (m *ResponsesModel) Provider() string { return m.provider }
func (m *ResponsesModel) ModelID() string  { return m.modelID }

func (m *ResponsesModel) genID() string {
	if m.GenerateID != nil {
		return m.GenerateID()
	}
	return llm.GenerateID()
}

func (m *ResponsesModel) url() string { return m.p.baseURL() + "/responses" }

var errorSchema = llm.Obj(llm.F{Key: "error", S: llm.Obj(
	llm.F{Key: "message", S: llm.Str()},
	llm.F{Key: "type", S: llm.Nullish(llm.Str())},
	llm.F{Key: "param", S: llm.Nullish(llm.Any())},
	llm.F{Key: "code", S: llm.Nullish(llm.Union(llm.Str(), llm.Number()))},
)})

// failedHandler is openaiFailedResponseHandler.
var failedHandler = llm.JSONErrorHandler(errorSchema, func(d any) string {
	return d.(*util.Obj).Get("error").(*util.Obj).Get("message").(string)
}, nil)
