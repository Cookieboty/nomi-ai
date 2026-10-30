package providers

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/toolnames"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var serverToolRe = regexp.MustCompile(`^(web_search|web_fetch|code_execution)_`)

// ServerToolUnsupported is SERVER_TOOL_UNSUPPORTED.
const ServerToolUnsupported = "当前模型不支持联网搜索"

func isServerTool(t any) bool {
	o, ok := t.(*u.Obj)
	if !ok || o == nil {
		return false
	}
	s, ok := o.Get("type").(string)
	return ok && serverToolRe.MatchString(s)
}

// IsDedicatedServerToolRequest is isDedicatedServerToolRequest.
func IsDedicatedServerToolRequest(o *u.Obj) bool {
	tools, _ := o.Get("tools").([]any)
	var server []*u.Obj
	for _, t := range tools {
		if isServerTool(t) {
			server = append(server, t.(*u.Obj))
		}
	}
	if len(server) == 0 {
		return false
	}
	if len(server) == len(tools) {
		return true
	}
	tc, ok := o.Get("tool_choice").(*u.Obj)
	if !ok || tc == nil || tc.Get("type") != "tool" {
		return false
	}
	for _, t := range server {
		if jsStrictEq(t.Get("name"), tc.Get("name")) {
			return true
		}
	}
	return false
}

func jsStrictEq(a, b any) bool {
	switch av := a.(type) {
	case *u.Obj:
		bv, ok := b.(*u.Obj)
		return ok && av == bv
	case []any:
		return false
	}
	if _, ok := b.([]any); ok {
		return false
	}
	if _, ok := b.(*u.Obj); ok {
		return false
	}
	return a == b
}

// ServerToolErrorFor is serverToolErrorFor ("" = null).
func ServerToolErrorFor(c *cand.Candidate, native, ingress string, body any) string {
	o, ok := body.(*u.Obj)
	if ingress != "messages" || native == "anthropic" || !ok || o == nil {
		return ""
	}
	if IsDedicatedServerToolRequest(o) {
		return ServerToolUnsupported + "（" + c.Provider.Name + "）"
	}
	return ""
}

func dropServerTools(o *u.Obj, notes *[]string) {
	tools, ok := o.Get("tools").([]any)
	if !ok || IsDedicatedServerToolRequest(o) {
		return
	}
	kept := []any{}
	var names []string
	for _, t := range tools {
		if isServerTool(t) {
			to := t.(*u.Obj)
			n := to.Get("name")
			if n == nil {
				n = to.Get("type")
			}
			names = append(names, u.JSString(n))
		} else {
			kept = append(kept, t)
		}
	}
	if len(kept) == len(tools) {
		return
	}
	o.Set("tools", kept)
	*notes = append(*notes, "服务端工具 "+strings.Join(names, "、")+" 已去掉（上游不是 Anthropic 官方）")
}

var schemaMaps = map[string]bool{"properties": true, "patternProperties": true, "$defs": true, "definitions": true, "dependentSchemas": true}
var schemaKeys = map[string]bool{"items": true, "prefixItems": true, "additionalItems": true, "additionalProperties": true,
	"unevaluatedProperties": true, "unevaluatedItems": true, "contains": true, "propertyNames": true, "not": true,
	"if": true, "then": true, "else": true, "anyOf": true, "oneOf": true, "allOf": true}
var stripKeywords = map[string]bool{"$schema": true, "examples": true}

// CleanToolSchema is cleanToolSchema.
func CleanToolSchema(schema any) any {
	if arr, ok := schema.([]any); ok {
		out := make([]any, len(arr))
		for i, x := range arr {
			out[i] = CleanToolSchema(x)
		}
		return out
	}
	o, ok := schema.(*u.Obj)
	if !ok || o == nil {
		return schema
	}
	out := u.NewObj()
	for _, k := range o.Keys() {
		v := o.Get(k)
		if stripKeywords[k] {
			continue
		}
		if vo, isO := v.(*u.Obj); schemaMaps[k] && isO && vo != nil {
			m := u.NewObj()
			for _, n := range vo.Keys() {
				m.Set(n, CleanToolSchema(vo.Get(n)))
			}
			out.Set(k, m)
		} else if schemaKeys[k] {
			out.Set(k, CleanToolSchema(v))
		} else {
			out.Set(k, v)
		}
	}
	return out
}

// MapToolSchemas is mapToolSchemas.
func MapToolSchemas(o *u.Obj, wire string, clean func(any) any) {
	tools, ok := o.Get("tools").([]any)
	if !ok {
		return
	}
	fix := func(t *u.Obj, key string) *u.Obj {
		if !t.Has(key) {
			return t
		}
		return t.Clone().Set(key, clean(t.Get(key)))
	}
	next := make([]any, len(tools))
	for i, x := range tools {
		t, ok := x.(*u.Obj)
		if !ok || t == nil {
			next[i] = x
			continue
		}
		switch wire {
		case "messages":
			next[i] = fix(t, "input_schema")
		case "responses":
			next[i] = fix(t, "parameters")
		case "chat":
			if fn, ok := t.Get("function").(*u.Obj); ok && fn != nil {
				next[i] = t.Clone().Set("function", fix(fn, "parameters"))
			} else {
				next[i] = t
			}
		case "gemini":
			if ds, ok := t.Get("functionDeclarations").([]any); ok {
				nd := make([]any, len(ds))
				for j, d := range ds {
					if do, ok := d.(*u.Obj); ok && do != nil {
						nd[j] = fix(fix(do, "parameters"), "parametersJsonSchema")
					} else {
						nd[j] = d
					}
				}
				next[i] = t.Clone().Set("functionDeclarations", nd)
			} else {
				next[i] = t
			}
		default:
			next[i] = nil // switch without a match returns undefined
		}
	}
	o.Set("tools", next)
}

func textOf(content any) []any {
	switch c := content.(type) {
	case string:
		if c == "" {
			return []any{}
		}
		return []any{u.NewObj("type", "text", "text", c)}
	case []any:
		out := []any{}
		for _, b := range c {
			if bo, ok := b.(*u.Obj); ok && bo != nil && bo.Get("type") == "text" {
				out = append(out, bo)
			}
		}
		return out
	}
	return []any{}
}

func isSystem(m any) bool {
	o, ok := m.(*u.Obj)
	return ok && o != nil && o.Get("role") == "system"
}

func mergeSystemMessages(o *u.Obj, notes *[]string) {
	msgs, ok := o.Get("messages").([]any)
	if !ok {
		return
	}
	var sys []*u.Obj
	rest := []any{}
	for _, m := range msgs {
		if isSystem(m) {
			sys = append(sys, m.(*u.Obj))
		} else {
			rest = append(rest, m)
		}
	}
	if len(sys) == 0 {
		return
	}
	o.Set("messages", rest)
	_, sysStr := o.Get("system").(string)
	allStrings := !o.Has("system") || sysStr
	for _, m := range sys {
		if !u.IsStr(m.Get("content")) {
			allStrings = false
		}
	}
	if allStrings {
		var parts []string
		if s, ok := o.Get("system").(string); ok && s != "" {
			parts = append(parts, s)
		}
		for _, m := range sys {
			if s := m.Get("content").(string); s != "" {
				parts = append(parts, s)
			}
		}
		o.Set("system", strings.Join(parts, "\n\n"))
	} else {
		out := textOf(o.Get("system"))
		for _, m := range sys {
			out = append(out, textOf(m.Get("content"))...)
		}
		o.Set("system", out)
	}
	*notes = append(*notes, strconv.Itoa(len(sys))+" 条对话中的 system 消息已合并进顶层 system")
}

var anthropicOnlyFields = []string{"output_config", "context_management"}

var (
	ctx1m = regexp.MustCompile(`(?i)^context-1m-`)
	ctxMg = regexp.MustCompile(`(?i)^context-management-`)
)

// FilterAnthropicBeta is filterAnthropicBeta.
func FilterAnthropicBeta(beta string) string {
	var out []string
	for _, s := range strings.Split(beta, ",") {
		s = u.JSTrim(s)
		if s != "" && !ctx1m.MatchString(s) && !ctxMg.MatchString(s) {
			out = append(out, s)
		}
	}
	return strings.Join(out, ",")
}

// GenericRequest is genericRequest.
func GenericRequest(wire string, o *u.Obj, ctx *Context) {
	if ctx.Native == "" {
		MapToolSchemas(o, wire, CleanToolSchema)
	}
	if wire == "messages" && ctx.Native != "anthropic" {
		mergeSystemMessages(o, ctx.Notes)
		dropServerTools(o, ctx.Notes)
		for _, k := range anthropicOnlyFields {
			if o.Has(k) {
				o.Delete(k)
				*ctx.Notes = append(*ctx.Notes, k+" 已去掉（上游不是 Anthropic 官方）")
			}
		}
	}
	q := ctx.Quirks
	if wire == "chat" && !(q.Fixes != nil && q.Fixes.ToolNames != nil && !*q.Fixes.ToolNames) {
		toolnames.MapChatToolNames(o, ctx.Notes)
	}
	if q.ExtraBody != nil {
		if extra, ok := q.ExtraBody.Get(wire).(*u.Obj); ok && extra != nil {
			o.Assign(extra)
		}
	}
}
