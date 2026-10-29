package anthropic

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type toolsIn struct {
	tools                      []llm.Tool
	choice                     *llm.ToolChoice
	disableParallel            *bool
	validator                  *cacheValidator
	supportsSO, supportsStrict bool
	defaultEager               bool
	rejectsForced              bool
}

type toolsOut struct {
	tools    any // undefined | []any
	choice   any // undefined | *util.Obj
	warnings []llm.Warning
	betas    set
}

func dpOrUndef(b *bool) any {
	if b == nil {
		return util.Undefined
	}
	return *b
}

func prepareTools(in toolsIn) (*toolsOut, error) {
	out := &toolsOut{tools: util.Undefined, choice: util.Undefined}
	if len(in.tools) == 0 {
		return out, nil
	}
	list := []any{}
	for _, t := range in.tools {
		if t.Type != "function" {
			// D-B5-P-A-2: Anthropic provider-defined tools are not ported.
			out.warnings = append(out.warnings, llm.Warning{Type: "unsupported", Feature: "provider-defined tool " + t.ID})
			continue
		}
		cc := in.validator.get(t.ProviderOptions, "tool definition", true)
		a := anth(t.ProviderOptions)
		eager := in.defaultEager
		if e, ok := get(a, "eagerInputStreaming").(bool); ok {
			eager = e
		}
		defer_ := get(a, "deferLoading")
		callers := get(a, "allowedCallers")
		if !in.supportsStrict && t.Strict != nil && *t.Strict {
			d := "Tool '" + t.Name + "' has strict: true, but strict mode is not supported by this provider. The strict property will be ignored."
			out.warnings = append(out.warnings, llm.Warning{Type: "unsupported", Feature: "strict", Details: &d})
		}
		o := util.NewObj("name", t.Name)
		if t.Description != nil {
			o.Set("description", *t.Description)
		} else {
			o.Set("description", util.Undefined)
		}
		o.Set("input_schema", t.InputSchema)
		o.Set("cache_control", cc)
		if eager {
			o.Set("eager_input_streaming", true)
		}
		if in.supportsStrict && t.Strict != nil {
			o.Set("strict", *t.Strict)
		}
		if defer_ != nil {
			o.Set("defer_loading", defer_)
		}
		if callers != nil {
			o.Set("allowed_callers", callers)
		}
		if t.InputExamples != nil {
			ex := make([]any, len(t.InputExamples))
			for i, e := range t.InputExamples {
				ex[i] = orUndef(get(asObj(e), "input"))
			}
			o.Set("input_examples", ex)
		}
		list = append(list, o)
		if in.supportsSO {
			out.betas.add("structured-outputs-2025-11-13")
		}
		if t.InputExamples != nil || callers != nil {
			out.betas.add("advanced-tool-use-2025-11-20")
		}
	}
	out.tools = list
	dp := dpOrUndef(in.disableParallel)
	auto := func() *util.Obj { return util.NewObj("type", "auto", "disable_parallel_tool_use", dp) }
	if in.choice == nil {
		if in.disableParallel != nil && *in.disableParallel {
			out.choice = auto()
		}
		return out, nil
	}
	switch in.choice.Type {
	case "auto":
		out.choice = auto()
	case "required":
		if in.rejectsForced {
			d := "toolChoice 'required' is not supported by this model because it rejects forced tool use. Using 'auto' instead. Instruct the model to use a tool in the prompt and verify that a tool call was made."
			out.warnings = append(out.warnings, llm.Warning{Type: "unsupported", Feature: "toolChoice", Details: &d})
			out.choice = auto()
		} else {
			out.choice = util.NewObj("type", "any", "disable_parallel_tool_use", dp)
		}
	case "none":
		out.tools = util.Undefined
	case "tool":
		name := in.choice.ToolName
		if in.rejectsForced {
			d := "toolChoice 'tool' is not supported by this model because it rejects forced tool use. Only the '" + name + "' tool is sent with 'auto' tool choice. Instruct the model to use the tool in the prompt and verify that a tool call was made."
			out.warnings = append(out.warnings, llm.Warning{Type: "unsupported", Feature: "toolChoice", Details: &d})
			f := []any{}
			for _, x := range list {
				if x.(*util.Obj).Get("name") == name {
					f = append(f, x)
				}
			}
			out.tools = f
			out.choice = auto()
		} else {
			out.choice = util.NewObj("type", "tool", "name", name, "disable_parallel_tool_use", dp)
		}
	default:
		return nil, llm.NewUnsupported("tool choice type: " + in.choice.Type)
	}
	return out, nil
}

func asObj(v any) *util.Obj { o, _ := v.(*util.Obj); return o }
