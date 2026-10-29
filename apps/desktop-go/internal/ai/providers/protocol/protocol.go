// Package protocol 对应 packages/ai-runtime/src/providers/protocol.ts：三种上游协议、
// 端点拼接与模型列表解析。单独成包是因为 Node 里 AiSdkLlmProvider 与 ProviderService
// 互相引用（Go 不允许包循环），协议这一层两边都要用。
package protocol

import (
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Protocol 只有三种：openai-chat / openai-responses / anthropic
type Protocol = string

var Protocols = []Protocol{"openai-chat", "openai-responses", "anthropic"}

// ProtocolLabels：PROTOCOL_LABELS（保持 Node 对象键序）
func ProtocolLabels() *u.Obj {
	return u.NewObj(
		"openai-chat", "ai-runtime.providers.protocol-openai-chat",
		"openai-responses", "ai-runtime.providers.protocol-openai-responses",
		"anthropic", "ai-runtime.providers.protocol-anthropic",
	)
}

func IsProtocol(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, p := range Protocols {
		if p == s {
			return true
		}
	}
	return false
}

var pathOf = map[Protocol]string{
	"openai-chat":      "/chat/completions",
	"openai-responses": "/responses",
	"anthropic":        "/messages",
}

var trailingSlashes = regexp.MustCompile(`/+$`)

// TrimBase：u.trim().replace(/\/+$/, ”)
func TrimBase(s string) string { return trailingSlashes.ReplaceAllString(u.JSTrim(s), "") }

var v1Suffix = regexp.MustCompile(`(?i)/v1$`)

func anthropicV1(base string) string {
	if v1Suffix.MatchString(base) {
		return base
	}
	return base + "/v1"
}

// SdkBaseURL：交给 SDK 的 baseURL（完整 URL 模式下去掉协议 PATH）
func SdkBaseURL(protocol Protocol, baseURL string, fullURL bool) string {
	base := TrimBase(baseURL)
	if fullURL {
		path := strings.SplitN(base, "?", 2)[0]
		suffix := pathOf[protocol]
		if strings.HasSuffix(u.JSLower(path), suffix) {
			return u.UTF16Slice0(path, u.UTF16Len(path)-u.UTF16Len(suffix))
		}
		return path
	}
	if protocol == "anthropic" {
		return anthropicV1(base)
	}
	return base
}

// EndpointURL：实际请求的端点
func EndpointURL(protocol Protocol, baseURL string, fullURL bool) string {
	base := TrimBase(baseURL)
	if fullURL {
		return base
	}
	return SdkBaseURL(protocol, base, false) + pathOf[protocol]
}

// ModelsURL：OpenAI 风格 GET {base}/models；Anthropic GET {base}/v1/models
func ModelsURL(protocol Protocol, baseURL string, fullURL bool) string {
	base := TrimBase(baseURL)
	if fullURL {
		suffix := pathOf[protocol]
		if strings.HasSuffix(u.JSLower(base), suffix) {
			base = u.UTF16Slice0(base, u.UTF16Len(base)-u.UTF16Len(suffix))
		} else if o, ok := urlOrigin(base); ok {
			ext := "/v1"
			if protocol == "anthropic" {
				ext = ""
			}
			base = o + ext
		}
	}
	if protocol == "anthropic" {
		return anthropicV1(base) + "/models"
	}
	return base + "/models"
}

// ModelsRequestHeaders：{ accept, ...extra } 再按协议补鉴权头
func ModelsRequestHeaders(protocol Protocol, apiKey string, extra *u.Obj) *u.Obj {
	h := u.NewObj("accept", "application/json")
	if extra != nil {
		h.Assign(extra)
	}
	if protocol == "anthropic" {
		if apiKey != "" {
			h.Set("x-api-key", apiKey)
		}
		h.Set("anthropic-version", "2023-06-01")
	} else if apiKey != "" {
		h.Set("authorization", "Bearer "+apiKey)
	}
	return h
}

// ParseModelList：兼容 OpenAI / Anthropic / Ollama / 裸数组，去重后按 localeCompare 排序
func ParseModelList(root any) []any {
	var arr []any
	if a, ok := root.([]any); ok {
		arr = a
	} else if o, ok := root.(*u.Obj); ok && o != nil {
		if a, ok := o.Get("data").([]any); ok {
			arr = a
		} else if a, ok := o.Get("models").([]any); ok {
			arr = a
		}
	}
	out := []any{}
	seen := map[string]bool{}
	for _, it := range arr {
		var o *u.Obj
		if s, ok := it.(string); ok {
			o = u.NewObj("id", s)
		} else {
			o, _ = it.(*u.Obj)
		}
		if o == nil {
			continue
		}
		id := ""
		for _, k := range []string{"id", "model", "name"} {
			if s, ok := o.Get(k).(string); ok && u.JSTrim(s) != "" {
				id = s
				break
			}
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		m := u.NewObj("id", id)
		if s, ok := o.Get("display_name").(string); ok && s != "" {
			m.Set("name", s)
		}
		if s, ok := o.Get("owned_by").(string); ok && s != "" {
			m.Set("ownedBy", s)
		}
		out = append(out, m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return models.LocaleCompare(u.AsObj(out[i]).Get("id").(string), u.AsObj(out[j]).Get("id").(string)) < 0
	})
	return out
}

// MapModel：精确匹配优先，其次 `*`
func MapModel(model string, mapping []any) string {
	if len(mapping) == 0 {
		return model
	}
	for _, it := range mapping {
		m := u.AsObj(it)
		if m != nil && m.Get("from") == model && u.JSTrim(u.Str(m.Get("to"))) != "" {
			return u.JSTrim(u.Str(m.Get("to")))
		}
	}
	for _, it := range mapping {
		m := u.AsObj(it)
		if m != nil && m.Get("from") == "*" && u.JSTrim(u.Str(m.Get("to"))) != "" {
			return u.JSTrim(u.Str(m.Get("to")))
		}
	}
	return model
}

var defaultPorts = map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}

// urlOrigin：new URL(s).origin；解析失败返回 false（Node 的 catch 分支：保留原值）
func urlOrigin(s string) (string, bool) {
	pu, err := url.Parse(s)
	if err != nil || pu.Scheme == "" {
		return "", false
	}
	scheme := strings.ToLower(pu.Scheme)
	dp, special := defaultPorts[scheme]
	if !special {
		return "null", true
	}
	host := strings.ToLower(pu.Hostname())
	if host == "" {
		return "", false
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := pu.Port(); port != "" && port != dp {
		host += ":" + port
	}
	return scheme + "://" + host, true
}
