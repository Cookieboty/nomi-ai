package shellhandlers

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/gwstore"
)

func runtimeEntries(env map[string]string) []llm.LLMProviderEntry {
	return runtime.LLMProvidersFromEnv(runtime.EnvLike(env))
}

func runtimeOverride(env map[string]string) string {
	return runtime.ProviderOverrideFromEnv(runtime.EnvLike(env))
}

// envProviderName / envProviderKey = createCore 的 ENV_PROVIDER_NAME / ENV_PROVIDER_KEY
var (
	envProviderName = map[string]string{"deepseek": "DeepSeek", "openai": "OpenAI", "claude": "Anthropic", "gemini": "Google Gemini", "ollama": "Ollama"}
	envProviderKey  = map[string]string{"deepseek": "DEEPSEEK_API_KEY", "openai": "OPENAI_API_KEY", "claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}
)

// GatewayEnvProviders = createCore 的 envProviders()：环境变量里的大模型供应商（模型页只读展示）
func GatewayEnvProviders(env map[string]string) []gwstore.EnvProvider {
	out := []gwstore.EnvProvider{}
	for _, e := range runtimeEntries(env) {
		if e.ID == "ollama" {
			if env["OLLAMA_BASE_URL"] == "" && env["OLLAMA_MODEL"] == "" {
				continue
			}
		} else if e.APIKey == "" {
			continue
		}
		c := aisdk.EnvProviderConfig(e)
		name := envProviderName[e.ID]
		if name == "" {
			name = e.ID
		}
		p := gwstore.EnvProvider{ID: e.ID, Name: name + "（环境变量）", Wire: "chat", URL: c.BaseURL}
		if c.Protocol == "anthropic" {
			p.Wire = "messages"
		}
		if e.APIKey != "" {
			p.Key, p.KeyEnv = e.APIKey, envProviderKey[e.ID]
		}
		if c.DefaultModel != "" && c.DefaultModel != "default" {
			p.Model = c.DefaultModel
		}
		if p.URL != "" {
			out = append(out, p)
		}
	}
	return out
}
