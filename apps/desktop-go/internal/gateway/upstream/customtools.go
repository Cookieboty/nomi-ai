package upstream

import (
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CustomToolNames is customToolNames (insertion-ordered set).
func CustomToolNames(body any) []string {
	out := []string{}
	if !u.IsObj(body) {
		return out
	}
	tools, ok := body.(*u.Obj).Get("tools").([]any)
	if !ok {
		return out
	}
	seen := map[string]bool{}
	for _, t := range tools {
		if !u.IsObj(t) { // `t && t.type` — arrays/primitives have no .type === 'custom'
			continue
		}
		to := t.(*u.Obj)
		name, ok := to.Get("name").(string)
		if to.Get("type") == "custom" && ok && !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

func customAsFunctionSchema() *u.Obj {
	return u.NewObj("type", "object", "properties", u.NewObj("input", u.NewObj("type", "string")), "required", []any{"input"})
}

var (
	reRefused    = u.CompileJSI(`unsupported|not\s+supported|does\s+not\s+support|invalid|unknown|not\s+allowed|不支持`)
	reCustomTool = u.CompileJSI(`custom[\s_-]*tools?`)
	reCustomCall = u.CompileJSI(`custom_tool_call`)
	reToolType   = u.CompileJSI(`tool\s+type\s+['"` + "`" + `]?custom`)
	reQuoted     = u.JSRe(`['"` + "`" + `]custom['"` + "`" + `]`)
	reTypeish    = u.CompileJSI(`type|tool|supported\s+values`)
)

// HasCustomTools is hasCustomTools.
func HasCustomTools(body any) bool { return len(CustomToolNames(body)) > 0 }

// IsCustomToolRefusal is isCustomToolRefusal; sent == Undefined means not passed.
func IsCustomToolRefusal(status float64, text string, sent any, hasSent bool) bool {
	if status != 400 && status != 422 {
		return false
	}
	if hasSent && !HasCustomTools(sent) {
		return false
	}
	if !reRefused.Test(text) {
		return false
	}
	return reCustomTool.Test(text) || reCustomCall.Test(text) || reToolType.Test(text) ||
		(reQuoted.MatchString(text) && reTypeish.Test(text))
}

// CustomToolsToFunctions is customToolsToFunctions (same pointer when unchanged).
func CustomToolsToFunctions(body any) any {
	if !u.IsObj(body) || !HasCustomTools(body) {
		return body
	}
	src := body.(*u.Obj)
	o := src.Clone()
	tools := src.Get("tools").([]any)
	nt := make([]any, len(tools))
	for i, t := range tools {
		if u.IsObj(t) && t.(*u.Obj).Get("type") == "custom" {
			to := t.(*u.Obj)
			f := u.NewObj("type", "function", "name", to.Get("name"))
			if d, ok := to.Get("description").(string); ok {
				f.Set("description", d)
			}
			f.Set("parameters", customAsFunctionSchema())
			nt[i] = f
		} else {
			nt[i] = t
		}
	}
	o.Set("tools", nt)
	if tc := o.Get("tool_choice"); u.IsObj(tc) && tc.(*u.Obj).Get("type") == "custom" {
		o.Set("tool_choice", tc.(*u.Obj).Clone().Set("type", "function"))
	}
	if in, ok := o.Get("input").([]any); ok {
		ni := make([]any, len(in))
		for i, it := range in {
			ni[i] = it
			if !u.IsObj(it) {
				continue
			}
			io := it.(*u.Obj)
			switch io.Get("type") {
			case "custom_tool_call":
				rest := io.Clone()
				input := rest.Get("input")
				rest.Delete("input")
				s, _ := input.(string)
				rest.Set("type", "function_call")
				rest.Set("arguments", u.Stringify(u.NewObj("input", s)))
				ni[i] = rest
			case "custom_tool_call_output":
				ni[i] = io.Clone().Set("type", "function_call_output")
			}
		}
		o.Set("input", ni)
	}
	return o
}
