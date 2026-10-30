package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/codex"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/grok"
	sh "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/shared"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
)

// modelArgsByBackend = MODEL_ARGS（dsh / gemini / external 没有 modelArgs）。
var modelArgsByBackend = map[string]func(sh.ModelArgsIn) []string{
	"claude": claude.ModelArgs, "codex": codex.ModelArgs, "grok": grok.ModelArgs,
}

func SupportsModelOverride(backend string) bool { return modelArgsByBackend[backend] != nil }

func IsAllowedModelID(backend, model string) bool {
	return SupportsModelOverride(backend) && clisdk.IsValidModelID(model)
}

// OverrideArgs = overrideArgs（model / effort nil = null/undefined）。
func OverrideArgs(backend string, model *string, effort any) []string {
	f := modelArgsByBackend[backend]
	if f == nil {
		return []string{}
	}
	in := sh.ModelArgsIn{}
	if model != nil {
		in.Model = *model
	}
	if clisdk.IsReasoningEffort(effort) {
		in.Effort = effort.(string)
	}
	return f(in)
}
