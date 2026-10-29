package shellhandlers

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime"
)

func runtimeEntries(env map[string]string) []llm.LLMProviderEntry {
	return runtime.LLMProvidersFromEnv(runtime.EnvLike(env))
}

func runtimeOverride(env map[string]string) string {
	return runtime.ProviderOverrideFromEnv(runtime.EnvLike(env))
}
