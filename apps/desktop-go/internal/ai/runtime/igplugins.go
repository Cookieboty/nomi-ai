// Package runtime 对应 packages/ai-runtime/src 的运行时装配层。本批只有 igPlugins.ts 的
// 环境变量推导（llmProvidersFromEnv / providerOverrideFromEnv）。
package runtime

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// EnvLike：process.env（缺失的键 = undefined）
type EnvLike map[string]string

func nonEmpty(v string) string { return u.JSTrim(v) }

func first(vals ...string) string {
	for _, v := range vals {
		if n := nonEmpty(v); n != "" {
			return n
		}
	}
	return ""
}

// LLMProvidersFromEnv：有 key 的云端在前，其次 ollama，最后无 key 的云端
func LLMProvidersFromEnv(env EnvLike) []llm.LLMProviderEntry {
	cloud := []llm.LLMProviderEntry{
		{ID: "deepseek", APIKey: nonEmpty(env["DEEPSEEK_API_KEY"]), BaseURL: nonEmpty(env["DEEPSEEK_BASE_URL"]), Model: nonEmpty(env["DEEPSEEK_MODEL"])},
		{ID: "openai", APIKey: nonEmpty(env["OPENAI_API_KEY"]), BaseURL: nonEmpty(env["OPENAI_BASE_URL"]), Model: nonEmpty(env["OPENAI_MODEL"])},
		{ID: "claude", APIKey: first(env["ANTHROPIC_API_KEY"], env["CLAUDE_API_KEY"]), BaseURL: first(env["ANTHROPIC_BASE_URL"], env["CLAUDE_BASE_URL"]), Model: first(env["ANTHROPIC_MODEL"], env["CLAUDE_MODEL"])},
		{ID: "gemini", APIKey: first(env["GOOGLE_GENERATIVE_AI_API_KEY"], env["GEMINI_API_KEY"]), BaseURL: first(env["GOOGLE_GENERATIVE_AI_BASE_URL"], env["GEMINI_BASE_URL"]), Model: first(env["GOOGLE_GENERATIVE_AI_MODEL"], env["GEMINI_MODEL"])},
	}
	ollama := llm.LLMProviderEntry{ID: "ollama", BaseURL: nonEmpty(env["OLLAMA_BASE_URL"]), Model: nonEmpty(env["OLLAMA_MODEL"])}
	out := []llm.LLMProviderEntry{}
	for _, p := range cloud {
		if p.APIKey != "" {
			out = append(out, p)
		}
	}
	out = append(out, ollama)
	for _, p := range cloud {
		if p.APIKey == "" {
			out = append(out, p)
		}
	}
	return out
}

// ProviderOverrideFromEnv：NOMI_PROVIDER
func ProviderOverrideFromEnv(env EnvLike) string { return nonEmpty(env["NOMI_PROVIDER"]) }
