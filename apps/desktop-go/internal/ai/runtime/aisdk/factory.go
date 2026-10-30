package aisdk

import (
	"net/http"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/anthropic"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/compatible"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm/openai"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ModelFactory：buildModelFactory 的产物（modelId → llm.LanguageModel）
type ModelFactory func(modelID string) llm.LanguageModel

// fullURLTransport：fullUrlFetch —— SDK 拼出的端点（不论是否带 query）改写为用户填写的完整地址
type fullURLTransport struct {
	inner       http.RoundTripper
	sdkEndpoint string
	target      string
}

func (t *fullURLTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if strings.SplitN(r.URL.String(), "?", 2)[0] == t.sdkEndpoint {
		r2 := r.Clone(r.Context())
		nu, err := r.URL.Parse(t.target)
		if err != nil {
			return nil, err
		}
		r2.URL, r2.Host = nu, nu.Host
		return t.inner.RoundTrip(r2)
	}
	return t.inner.RoundTrip(r)
}

func fullURLClient(proto protocol.Protocol, baseURL string, fullURL bool, base *http.Client) *http.Client {
	if !fullURL {
		return base
	}
	inner := http.DefaultTransport
	if base != nil && base.Transport != nil {
		inner = base.Transport
	}
	target := protocol.TrimBase(baseURL)
	ep := protocol.SdkBaseURL(proto, target, true) + protocol.PathOf(proto)
	if ep == target {
		return base
	}
	return &http.Client{Transport: &fullURLTransport{inner: inner, sdkEndpoint: ep, target: target}}
}

// BuildModelFactory：buildModelFactory
func BuildModelFactory(opts Options) ModelFactory {
	proto := protocol.Protocol(or(opts.Protocol, "openai-chat"))
	var hdrs []llm.Header
	if o, ok := opts.Headers.(*u.Obj); ok {
		for _, k := range o.Keys() {
			if s, ok := o.Get(k).(string); ok {
				hdrs = append(hdrs, llm.H(k, s))
			}
		}
	}
	if ua := u.JSTrim(opts.UserAgent); ua != "" {
		hdrs = setHeader(hdrs, "User-Agent", ua)
	}
	full := opts.FullURL != nil && *opts.FullURL
	baseURL := protocol.SdkBaseURL(proto, opts.BaseURL, full)
	client := fullURLClient(proto, opts.BaseURL, full, opts.Client)
	switch proto {
	case "anthropic":
		// createAnthropic({ apiKey: apiKey ?? '', baseURL, headers, fetch }).messages(modelId)
		p := anthropic.New(anthropic.Settings{APIKey: opts.APIKey, BaseURL: baseURL, Headers: hdrs, Client: client})
		return p.Messages
	case "openai-responses":
		p := openai.New(openai.Settings{APIKey: opts.APIKey, BaseURL: baseURL, Headers: hdrs, Client: client, Name: opts.ID})
		return func(id string) llm.LanguageModel { return p.Responses(id) }
	}
	p := compatible.New(compatible.Settings{Name: opts.ID, BaseURL: baseURL, APIKey: opts.APIKey, Headers: hdrs, IncludeUsage: true, Client: client})
	return p.ChatModel
}

// setHeader：headers['User-Agent'] = v（已有同名键则原位覆盖，保持 JS 对象键序）
func setHeader(hs []llm.Header, name, v string) []llm.Header {
	for i := range hs {
		if hs[i].Name == name {
			hs[i].Value = v
			return hs
		}
	}
	return append(hs, llm.H(name, v))
}
