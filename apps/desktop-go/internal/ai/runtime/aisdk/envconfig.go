// Package aisdk 对应 packages/ai-runtime/src/ai-sdk。本批只有 AiSdkLlmProvider.ts 的
// envProviderConfig / ENV_PROTOCOL 与选项类型；适配器本体属批次 5。
package aisdk

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"

// Options：AiSdkLlmProviderOptions 中与配置相关的字段（指针 = 可为 undefined）
type Options struct {
	ID             string
	Protocol       string
	BaseURL        string
	FullURL        *bool
	APIKey         string
	DefaultModel   string
	RequiresAPIKey *bool
	ModelMap       []any
	Thinking       *bool
	UserAgent      string
	Headers        any
}

// EnvProtocol：ENV_PROTOCOL
var EnvProtocol = map[string]string{"claude": "anthropic"}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// EnvProviderConfig：envProviderConfig
func EnvProviderConfig(e llm.LLMProviderEntry) Options {
	d, ok := llm.EnvEndpointDefaultsByID[e.ID]
	req := e.APIKey != ""
	if ok {
		req = d.RequiresAPIKey
	}
	return Options{
		ID:             e.ID,
		Protocol:       or(EnvProtocol[e.ID], "openai-chat"),
		APIKey:         e.APIKey,
		BaseURL:        or(e.BaseURL, or(d.BaseURL, "http://127.0.0.1")),
		DefaultModel:   or(e.Model, or(d.Model, "default")),
		RequiresAPIKey: &req,
	}
}
