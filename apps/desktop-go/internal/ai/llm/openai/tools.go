package openai

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func get(o *util.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

func objAt(o *util.Obj, k string) *util.Obj { x, _ := get(o, k).(*util.Obj); return x }

func orUndef(v any) any {
	if v == nil {
		return util.Undefined
	}
	return v
}

func numOrUndef(n *float64) any {
	if n == nil {
		return util.Undefined
	}
	return *n
}

var builtinChoice = map[string]bool{"code_interpreter": true, "file_search": true, "image_generation": true,
	"web_search_preview": true, "web_search": true, "mcp": true, "apply_patch": true, "computer": true,
	"programmatic_tool_calling": true}

// prepareTools is prepareResponsesTools for function tools (provider tools:
// D-B5-P-7 → UnsupportedFunctionalityError).
func prepareTools(tools []llm.Tool, choice *llm.ToolChoice, supportsAsync bool) (any, any, []llm.Warning, error) {
	var warnings []llm.Warning
	if len(tools) == 0 {
		return util.Undefined, util.Undefined, warnings, nil
	}
	out := []any{}
	namespaces := map[string]*util.Obj{}
	for _, t := range tools {
		if t.Type != "function" {
			return nil, nil, nil, llm.NewUnsupported("provider-defined tool " + t.ID + " (Go runtime)")
		}
		opts := objAt(t.ProviderOptions, "openai")
		async := get(opts, "async")
		if async == true && !supportsAsync {
			warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: `async tool calling for "` + t.Name + `"`,
				Details: sp("Async tool calling is only supported by GPT-6 and later models.")})
			async = nil
		}
		params, ws, err := normalizeJSONSchema(t.InputSchema)
		if err != nil {
			return nil, nil, nil, err
		}
		warnings = append(warnings, ws...)
		var outSchema any
		if os := get(opts, "outputSchema"); os != nil {
			if outSchema, ws, err = normalizeJSONSchema(os); err != nil {
				return nil, nil, nil, err
			}
			warnings = append(warnings, ws...)
		}
		ft := util.NewObj("type", "function", "name", t.Name)
		if t.Description != nil {
			ft.Set("description", *t.Description)
		} else {
			ft.Set("description", util.Undefined)
		}
		ft.Set("parameters", params)
		if async != nil {
			ft.Set("async", async)
		}
		ft.Set("strict", t.Strict != nil && *t.Strict)
		if d := get(opts, "deferLoading"); d != nil {
			ft.Set("defer_loading", d)
		}
		if c := get(opts, "allowedCallers"); c != nil {
			ft.Set("allowed_callers", c)
		}
		if outSchema != nil {
			ft.Set("output_schema", outSchema)
		}
		ns := objAt(opts, "namespace")
		if ns == nil {
			out = append(out, ft)
			continue
		}
		name, _ := ns.Get("name").(string)
		nt := namespaces[name]
		if nt == nil {
			nt = util.NewObj("type", "namespace", "name", name, "description", ns.Get("description"), "tools", []any{})
			namespaces[name] = nt
			out = append(out, nt)
		} else if nt.Get("description") != ns.Get("description") {
			return nil, nil, nil, llm.NewUnsupported(`conflicting descriptions for OpenAI tool namespace "` + name + `"`)
		}
		nt.Set("tools", append(nt.Get("tools").([]any), ft))
	}
	if choice == nil {
		return out, util.Undefined, warnings, nil
	}
	switch choice.Type {
	case "auto", "none", "required":
		return out, choice.Type, warnings, nil
	case "tool":
		if builtinChoice[choice.ToolName] {
			return out, util.NewObj("type", choice.ToolName), warnings, nil
		}
		return out, util.NewObj("type", "function", "name", choice.ToolName), warnings, nil
	}
	return nil, nil, nil, llm.NewUnsupported("tool choice type: " + choice.Type)
}
