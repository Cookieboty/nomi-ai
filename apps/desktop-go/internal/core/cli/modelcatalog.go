package cli

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
)

// modelArgsOf：启动时指定模型 / 思考深度的参数（插件 Launch.ModelArgs；dsh / gemini / external 没有）
func modelArgsOf(backend string) func(clisdk.ModelArgsOpts) []string {
	if m := builtin.Impl(backend); m != nil {
		return m.Launch.ModelArgs
	}
	return nil
}

func SupportsModelOverride(backend string) bool { return modelArgsOf(backend) != nil }

func IsAllowedModelID(backend, model string) bool {
	return SupportsModelOverride(backend) && clisdk.IsValidModelID(model)
}

// OverrideArgs = overrideArgs（model / effort nil = null/undefined）。
func OverrideArgs(backend string, model *string, effort any) []string {
	f := modelArgsOf(backend)
	if f == nil {
		return []string{}
	}
	in := clisdk.ModelArgsOpts{Model: model}
	if clisdk.IsReasoningEffort(effort) {
		e := effort.(string)
		in.Effort = &e
	}
	return f(in)
}
