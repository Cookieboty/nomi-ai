package media

import (
	"net/url"
	"regexp"
	"strings"
)

// Rule = ImageEndpointRule
type Rule struct {
	Adapter string
	Model   *regexp.Regexp
	Presets []string
	Host    *regexp.Regexp
	// Wire：用供应商哪个协议的地址与 Key（默认 chat）
	Wire string
	// Base："origin" = 只取站点根
	Base string
}

// Rules = IMAGE_ENDPOINT_RULES（顺序与 Node 一致：带供应商限定的在前，OpenAI Images 兜底）
var Rules = []Rule{
	{Adapter: "openrouter-chat-image", Host: regexp.MustCompile(`(?i)(^|\.)openrouter\.ai$`), Presets: []string{"openrouter"}},
	{Adapter: "gemini", Model: regexp.MustCompile(`(?i)^gemini.*image`), Wire: "gemini",
		Host: regexp.MustCompile(`(?i)generativelanguage\.googleapis\.com$`), Presets: []string{"gemini"}},
	{Adapter: "imagen", Model: regexp.MustCompile(`(?i)^imagen`), Wire: "gemini",
		Host: regexp.MustCompile(`(?i)generativelanguage\.googleapis\.com$`), Presets: []string{"gemini"}},
	{Adapter: "ark-image", Model: regexp.MustCompile(`(?i)seedream|seededit`),
		Host: regexp.MustCompile(`(?i)volces\.com$`), Presets: []string{"doubao", "volcengine"}},
	{Adapter: "fal", Host: regexp.MustCompile(`(?i)(^|\.)fal\.(run|ai)$`), Presets: []string{"fal"}},
	{Adapter: "dashscope-async", Model: regexp.MustCompile(`(?i)^(wanx|wan\d|qwen-image)`),
		Host: regexp.MustCompile(`(?i)(^|\.)dashscope(-intl)?\.aliyuncs\.com$`), Presets: []string{"dashscope", "qwen", "bailian"}, Base: "origin"},
	{Adapter: "gemini", Model: regexp.MustCompile(`(?i)^gemini.*image`), Wire: "gemini"},
	{Adapter: "imagen", Model: regexp.MustCompile(`(?i)^imagen`), Wire: "gemini"},
	{Adapter: "openai-images"},
}

func hostOf(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return p.Hostname()
}

func providerMatches(r Rule, p ProviderInfo) bool {
	if len(r.Presets) == 0 && r.Host == nil {
		return true
	}
	if p.PresetID != "" {
		for _, x := range r.Presets {
			if x == p.PresetID {
				return true
			}
		}
	}
	if r.Host != nil {
		for _, u := range p.URLs {
			if r.Host.MatchString(hostOf(u)) {
				return true
			}
		}
	}
	return false
}

func baseOf(u, how string) string {
	if how == "origin" {
		if p, err := url.Parse(u); err == nil && p.Scheme != "" && p.Host != "" {
			return p.Scheme + "://" + p.Host
		}
	}
	return trimSlash(u)
}

func authFor(adapterAuth string, detected map[string]string, wire string) string {
	if adapterAuth == AuthKey {
		return AuthKey
	}
	if a := detected[wire]; a != "" {
		return a
	}
	return adapterAuth
}

// Resolve = resolveImageEndpoint；rules 为 nil 时用 Rules
func Resolve(p ProviderInfo, upstream string, rules []Rule) *Endpoint {
	if rules == nil {
		rules = Rules
	}
	bare := strings.TrimPrefix(upstream, "models/")
	last := bare[strings.LastIndex(bare, "/")+1:]
	for _, r := range rules {
		if r.Model != nil && !r.Model.MatchString(bare) && !r.Model.MatchString(last) {
			continue
		}
		if !providerMatches(r, p) {
			continue
		}
		wire := r.Wire
		if wire == "" {
			wire = "chat"
		}
		u := p.URLs[wire]
		a := Adapters[r.Adapter]
		if u == "" || a == nil {
			continue
		}
		return &Endpoint{Adapter: a, BaseURL: baseOf(u, r.Base), Wire: wire, Auth: authFor(a.Auth, p.Auth, wire)}
	}
	return nil
}

// AuthHeaders = imageAuthHeaders
func AuthHeaders(auth, key string) map[string]string {
	if key == "" {
		return map[string]string{}
	}
	switch auth {
	case AuthKey:
		return map[string]string{"Authorization": "Key " + key}
	case AuthGoog:
		return map[string]string{"x-goog-api-key": key}
	case AuthXAPI:
		return map[string]string{"x-api-key": key}
	}
	return map[string]string{"Authorization": "Bearer " + key}
}
