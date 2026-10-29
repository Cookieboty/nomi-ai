package anthropic

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ---- small JS helpers ----

func get(o *util.Obj, k string) any {
	if o == nil {
		return nil
	}
	v := o.Get(k)
	if v == util.Undefined {
		return nil
	}
	return v
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

func pf(f float64) *float64 { return &f }

// anth is providerOptions?.anthropic (any JSON).
func anth(po *util.Obj) *util.Obj { return objAt(po, "anthropic") }

// ---- CacheControlValidator ----

type cacheValidator struct {
	count    int
	warnings []llm.Warning
}

func (c *cacheValidator) get(po *util.Obj, typ string, canCache bool) any {
	a := anth(po)
	v := get(a, "cacheControl")
	if v == nil {
		v = nil
	}
	if !util.Truthy(v) {
		return util.Undefined
	}
	if !canCache {
		d := "cache_control cannot be set on " + typ + ". It will be ignored."
		c.warnings = append(c.warnings, llm.Warning{Type: "unsupported", Feature: "cache_control on non-cacheable context", Details: &d})
		return util.Undefined
	}
	c.count++
	if c.count > 4 {
		d := "Maximum 4 cache breakpoints exceeded (found " + util.FormatNumber(float64(c.count)) + "). This breakpoint will be ignored."
		c.warnings = append(c.warnings, llm.Warning{Type: "unsupported", Feature: "cacheControl breakpoint limit", Details: &d})
		return util.Undefined
	}
	return v
}

// firstCache is `a ?? b ?? c` over cache-control lookups (lazy, in order).
func firstCache(fs ...func() any) any {
	for _, f := range fs {
		if v := f(); v != util.Undefined {
			return v
		}
	}
	return util.Undefined
}

func otherWarning(msg string) llm.Warning { return llm.Warning{Type: "other", Message: msg} }

// ---- convertToAnthropicPrompt ----

type block struct {
	typ  string // system | assistant | user
	msgs []llm.Message
}

func groupIntoBlocks(prompt []llm.Message) []*block {
	var out []*block
	var cur *block
	for _, m := range prompt {
		t := m.Role
		if t == "tool" {
			t = "user"
		}
		if cur == nil || cur.typ != t {
			cur = &block{typ: t}
			out = append(out, cur)
		}
		cur.msgs = append(cur.msgs, m)
	}
	return out
}

type converted struct {
	system   any // undefined | []any
	messages []any
	betas    set
}

type convertCtx struct {
	sendReasoning bool
	warnings      *[]llm.Warning
	validator     *cacheValidator
	toProvider    func(string) string
}

func strOpt(o *util.Obj, k string) (string, bool) { s, ok := get(o, k).(string); return s, ok }

func docMeta(po *util.Obj, filename string, cc any, src *util.Obj) *util.Obj {
	a := anth(po)
	d := util.NewObj("type", "document", "source", src)
	if t, ok := strOpt(a, "title"); ok {
		d.Set("title", t)
	} else if filename != "" {
		d.Set("title", filename)
	} else {
		d.Set("title", util.Undefined)
	}
	if c, ok := strOpt(a, "context"); ok && c != "" {
		d.Set("context", c)
	}
	if get(objAt(a, "citations"), "enabled") == true {
		d.Set("citations", util.NewObj("enabled", true))
	}
	d.Set("cache_control", cc)
	return d
}

func bytesToString(d llm.FileData) string {
	b := d.Bytes
	if d.IsString {
		b = llm.Base64ToBytes(d.Base64)
	}
	var td util.TextDecoder
	return td.Decode(b) + td.Flush()
}

func callerOf(po *util.Obj) *util.Obj {
	c := objAt(anth(po), "caller")
	t, _ := strOpt(c, "type")
	if t == "code_execution_20250825" || t == "code_execution_20260120" {
		if id, ok := strOpt(c, "toolId"); ok && id != "" {
			return util.NewObj("type", t, "tool_id", id)
		}
	}
	if t == "direct" {
		return util.NewObj("type", "direct")
	}
	return nil
}

func toolInput(in any) any {
	if o, ok := in.(*util.Obj); ok {
		return o
	}
	return util.NewObj("rawInvalidInput", in)
}

func toolsetName(p llm.Part) (string, bool) {
	return strOpt(anth(p.ProviderOptions), "toolsetName")
}

func convertPrompt(prompt []llm.Message, cx convertCtx) (*converted, error) {
	res := &converted{system: util.Undefined}
	blocks := groupIntoBlocks(prompt)
	v := cx.validator
	lastUser := -1
	systemSet := false
	for i, b := range blocks {
		isLastBlock := i == len(blocks)-1
		switch b.typ {
		case "system":
			type cm struct {
				content         []any
				clearAt, effort any
				toolChanges     int
			}
			var cms []cm
			for _, m := range b.msgs {
				so := anth(m.ProviderOptions)
				tcs, _ := get(so, "toolChanges").([]any)
				clearAt, effort := get(so, "clearAt"), get(so, "effort")
				var content []any
				if m.Text != "" || (len(tcs) == 0 && clearAt == nil && effort == nil) {
					content = append(content, util.NewObj("type", "text", "text", m.Text,
						"cache_control", v.get(m.ProviderOptions, "system message", true)))
				}
				for _, x := range tcs {
					tc, _ := x.(*util.Obj)
					name, _ := strOpt(tc, "toolName")
					content = append(content, util.NewObj("type", get(tc, "type"),
						"tool", util.NewObj("type", "tool_reference", "name", cx.toProvider(name))))
				}
				cms = append(cms, cm{content, clearAt, effort, len(tcs)})
			}
			total, inline := 0, false
			for _, c := range cms {
				total += c.toolChanges
				if c.clearAt != nil || c.effort != nil {
					inline = true
				}
			}
			if i == 0 || (!systemSet && total == 0 && !inline) {
				if total > 0 {
					*cx.warnings = append(*cx.warnings, otherWarning("tool changes on the initial system message are not supported by Anthropic. Configure the initial tool set via the tools option instead. The tool changes have been ignored."))
				}
				for _, c := range cms {
					if len(c.content) == 0 && c.clearAt == nil && c.effort != nil {
						res.messages = append(res.messages, util.NewObj("role", "system", "content", []any{}, "output_config", util.NewObj("effort", c.effort)))
						res.betas.add("mid-conversation-output-config-2026-07-01")
					} else if c.clearAt != nil || c.effort != nil {
						*cx.warnings = append(*cx.warnings, otherWarning("clearAt and effort on this initial system message are not supported by Anthropic. Use a separate effort-only system message with empty content to set effort. These options have been ignored."))
					}
				}
				sys := []any{}
				for _, c := range cms {
					for _, p := range c.content {
						if p.(*util.Obj).Get("type") == "text" {
							sys = append(sys, p)
						}
					}
				}
				res.system, systemSet = sys, true
			} else {
				res.betas.add("mid-conversation-system-2026-04-07")
				for _, c := range cms {
					content := c.content
					if content == nil {
						content = []any{}
					}
					m := util.NewObj("role", "system", "content", content)
					if c.clearAt != nil {
						m.Set("clear_at", c.clearAt)
					}
					if c.effort != nil {
						m.Set("output_config", util.NewObj("effort", c.effort))
					}
					res.messages = append(res.messages, m)
					if c.toolChanges > 0 {
						res.betas.add("mid-conversation-tool-changes-2026-07-01")
					}
					if c.clearAt != nil {
						res.betas.add("mid-conversation-system-clear-at-2026-08-21")
					}
					if c.effort != nil {
						res.betas.add("mid-conversation-output-config-2026-07-01")
					}
				}
			}
		case "user":
			content := []any{}
			for _, m := range b.msgs {
				if m.Role == "user" {
					if len(m.Parts) > 0 {
						lastUser = len(res.messages)
					}
					for j, p := range m.Parts {
						isLast := j == len(m.Parts)-1
						mp := m.ProviderOptions
						cc := firstCache(
							func() any { return v.get(p.ProviderOptions, "user message part", true) },
							func() any {
								if isLast {
									return v.get(mp, "user message", true)
								}
								return util.Undefined
							})
						switch p.Type {
						case "text":
							content = append(content, util.NewObj("type", "text", "text", p.Text, "cache_control", cc))
						case "file":
							item, err := userFile(p, cc, &res.betas)
							if err != nil {
								return nil, err
							}
							content = append(content, item)
						}
					}
					continue
				}
				// tool
				for k, p := range m.Parts {
					if p.Type == "tool-approval-response" {
						continue
					}
					out := p.Output
					if out == nil {
						out = &llm.ToolResultOutput{Type: "json"}
					}
					var outPO *util.Obj
					if out.ProviderOptions != nil {
						outPO = out.ProviderOptions
					} else if out.Type == "content" {
						for _, c := range out.Content {
							if c.ProviderOptions != nil {
								outPO = c.ProviderOptions
								break
							}
						}
					}
					isLast := k == len(m.Parts)-1
					mp := m.ProviderOptions
					cc := firstCache(
						func() any { return v.get(p.ProviderOptions, "tool result part", true) },
						func() any { return v.get(outPO, "tool result output", true) },
						func() any {
							if isLast {
								return v.get(mp, "tool result message", true)
							}
							return util.Undefined
						})
					var cv any
					switch out.Type {
					case "content":
						arr := []any{}
						for _, c := range out.Content {
							if x := toolContentPart(c, cx.warnings, &res.betas); x != nil {
								arr = append(arr, x)
							}
						}
						cv = arr
					case "text", "error-text":
						cv = out.Value
					case "execution-denied":
						if out.Reason != nil {
							cv = *out.Reason
						} else {
							cv = "Tool call execution denied."
						}
					default:
						cv = util.Stringify(out.Value)
					}
					tr := util.NewObj("type", "tool_result", "tool_use_id", p.ToolCallID)
					if ts, ok := toolsetName(p); ok {
						tr.Set("toolset_name", ts)
					}
					isErr := any(util.Undefined)
					if out.Type == "error-text" || out.Type == "error-json" {
						isErr = true
					}
					tr.Set("content", cv)
					tr.Set("is_error", isErr)
					tr.Set("cache_control", cc)
					content = append(content, tr)
				}
			}
			res.messages = append(res.messages, util.NewObj("role", "user", "content", content))
		case "assistant":
			content := []any{}
			mcpIDs := map[string]bool{}
			for j, m := range b.msgs {
				isLastMsg := j == len(b.msgs)-1
				for k, p := range m.Parts {
					isLastPart := k == len(m.Parts)-1
					mp := m.ProviderOptions
					cc := firstCache(
						func() any { return v.get(p.ProviderOptions, "assistant message part", true) },
						func() any {
							if isLastPart {
								return v.get(mp, "assistant message", true)
							}
							return util.Undefined
						})
					a := anth(p.ProviderOptions)
					switch p.Type {
					case "text":
						if get(a, "type") == "compaction" {
							if p.Text == "" {
								break
							}
							c := util.NewObj("type", "compaction", "content", p.Text)
							if sig, ok := strOpt(a, "signature"); ok {
								res.betas.add("compact-2026-09-04")
								c.Set("signature", sig)
							}
							c.Set("cache_control", cc)
							content = append(content, c)
							break
						}
						text := p.Text
						if isLastBlock && isLastMsg && isLastPart {
							text = util.JSTrim(text)
						}
						t := util.NewObj("type", "text", "text", text)
						if c := get(a, "citations"); c != nil {
							t.Set("citations", c)
						}
						t.Set("cache_control", cc)
						content = append(content, t)
					case "reasoning":
						if !cx.sendReasoning {
							*cx.warnings = append(*cx.warnings, otherWarning("sending reasoning content is disabled for this model"))
							break
						}
						var md *util.Obj
						if raw := get(p.ProviderOptions, "anthropic"); raw != nil {
							x, err := llm.Validate(raw, reasoningMetadataSchema)
							if err != nil {
								return nil, &llm.InvalidArgumentError{Argument: "providerOptions", Message: "invalid anthropic provider options"}
							}
							md, _ = x.(*util.Obj)
						}
						if sig, ok := strOpt(md, "signature"); ok {
							v.get(p.ProviderOptions, "thinking block", false)
							content = append(content, util.NewObj("type", "thinking", "thinking", p.Text, "signature", sig))
						} else if rd, ok := strOpt(md, "redactedData"); ok {
							v.get(p.ProviderOptions, "redacted thinking block", false)
							content = append(content, util.NewObj("type", "redacted_thinking", "data", rd))
						} else {
							*cx.warnings = append(*cx.warnings, otherWarning("unsupported reasoning metadata"))
						}
					case "custom":
						if p.Kind != "anthropic.fallback" {
							break
						}
						from, to := objAt(a, "from"), objAt(a, "to")
						fm, ok1 := strOpt(from, "model")
						tm, ok2 := strOpt(to, "model")
						if get(a, "type") != "fallback" || !ok1 || !ok2 {
							*cx.warnings = append(*cx.warnings, otherWarning("anthropic fallback metadata must include from.model and to.model"))
							break
						}
						res.betas.add("server-side-fallback-2026-06-01")
						content = append(content, util.NewObj("type", "fallback", "from", util.NewObj("model", fm), "to", util.NewObj("model", tm)))
					case "tool-call":
						caller := callerOf(p.ProviderOptions)
						withCaller := func(o *util.Obj) *util.Obj {
							if caller != nil {
								o.Set("caller", caller)
							}
							o.Set("cache_control", cc)
							return o
						}
						if p.ProviderExec {
							name := cx.toProvider(p.ToolName)
							in, _ := p.Input.(*util.Obj)
							inType, _ := strOpt(in, "type")
							switch {
							case get(a, "type") == "mcp-tool-use":
								mcpIDs[p.ToolCallID] = true
								sn, ok := strOpt(a, "serverName")
								if !ok {
									*cx.warnings = append(*cx.warnings, otherWarning("mcp tool use server name is required and must be a string"))
									break
								}
								content = append(content, util.NewObj("type", "mcp_tool_use", "id", p.ToolCallID, "name", p.ToolName,
									"input", p.Input, "server_name", sn, "cache_control", cc))
							case name == "code_execution" && in != nil && (inType == "bash_code_execution" || inType == "text_editor_code_execution"):
								rest := in.Clone()
								rest.Delete("type")
								content = append(content, withCaller(util.NewObj("type", "server_tool_use", "id", p.ToolCallID, "name", inType, "input", rest)))
							case name == "code_execution" && in != nil && inType == "programmatic-tool-call":
								rest := in.Clone()
								rest.Delete("type")
								content = append(content, withCaller(util.NewObj("type", "server_tool_use", "id", p.ToolCallID, "name", "code_execution", "input", rest)))
							case name == "code_execution" || name == "web_fetch" || name == "web_search" ||
								name == "tool_search_tool_regex" || name == "tool_search_tool_bm25":
								content = append(content, withCaller(util.NewObj("type", "server_tool_use", "id", p.ToolCallID, "name", name, "input", p.Input)))
							case name == "advisor":
								content = append(content, withCaller(util.NewObj("type", "server_tool_use", "id", p.ToolCallID, "name", "advisor", "input", util.NewObj())))
							default:
								*cx.warnings = append(*cx.warnings, otherWarning("provider executed tool call for tool "+p.ToolName+" is not supported"))
							}
							break
						}
						if ts, ok := toolsetName(p); ok {
							raw := toolInput(p.Input).(*util.Obj)
							act, hasAct := raw.Get("action").(string)
							if !hasAct {
								*cx.warnings = append(*cx.warnings, otherWarning("toolset tool call for tool "+p.ToolName+" is missing the action"))
								act = ts
							}
							content = append(content, withCaller(util.NewObj("type", "tool_use", "id", p.ToolCallID, "name", act, "toolset_name", ts, "input", raw)))
							break
						}
						content = append(content, withCaller(util.NewObj("type", "tool_use", "id", p.ToolCallID, "name", p.ToolName, "input", toolInput(p.Input))))
					case "tool-result":
						// D-B5-P-A-1: provider-executed tool results (server tools / MCP) are not ported.
						if mcpIDs[p.ToolCallID] && p.Output != nil && p.Output.Type != "json" && p.Output.Type != "error-json" {
							*cx.warnings = append(*cx.warnings, otherWarning("provider executed tool result output type "+p.Output.Type+" for tool "+p.ToolName+" is not supported"))
							break
						}
						*cx.warnings = append(*cx.warnings, otherWarning("provider executed tool result for tool "+p.ToolName+" is not supported"))
					}
				}
			}
			if len(content) > 0 {
				res.messages = append(res.messages, util.NewObj("role", "assistant", "content", moveToolUseToEnd(content)))
			}
		}
	}
	// drop orphaned caller metadata before the last user message
	codeExec := map[string]bool{}
	for _, m := range res.messages {
		mo := m.(*util.Obj)
		if mo.Get("role") != "assistant" {
			continue
		}
		for _, x := range mo.Get("content").([]any) {
			po := x.(*util.Obj)
			if po.Get("type") == "server_tool_use" && po.Get("name") == "code_execution" {
				codeExec[po.Get("id").(string)] = true
			}
		}
	}
	warned := map[string]bool{}
	for i := 0; i < lastUser; i++ {
		mo := res.messages[i].(*util.Obj)
		if mo.Get("role") != "assistant" {
			continue
		}
		for _, x := range mo.Get("content").([]any) {
			po := x.(*util.Obj)
			if !po.Has("caller") {
				continue
			}
			c, _ := po.Get("caller").(*util.Obj)
			if c == nil || c.Get("type") == "direct" {
				continue
			}
			tid, _ := c.Get("tool_id").(string)
			if codeExec[tid] {
				continue
			}
			id, ok := po.Get("id").(string)
			if !ok {
				id, _ = po.Get("tool_use_id").(string)
			}
			po.Delete("caller")
			if !warned[id] {
				warned[id] = true
				*cx.warnings = append(*cx.warnings, otherWarning("Omitted caller metadata for tool "+id+" because source code execution tool "+tid+" is missing from the conversation history."))
			}
		}
	}
	if res.messages == nil {
		res.messages = []any{}
	}
	return res, nil
}

func userFile(p llm.Part, cc any, betas *set) (any, error) {
	a := anth(p.ProviderOptions)
	switch p.Data.Type {
	case "reference":
		ref := p.Data.Reference
		id, ok := strOpt(ref, "anthropic")
		if !ok {
			return nil, &llm.InvalidArgumentError{Argument: "reference", Message: "No provider reference found for provider 'anthropic'"}
		}
		betas.add("files-api-2025-04-14")
		if get(a, "containerUpload") == true {
			return util.NewObj("type", "container_upload", "file_id", id), nil
		}
		t := "document"
		if llm.TopLevelMediaType(p.MediaType) == "image" {
			t = "image"
		}
		return util.NewObj("type", t, "source", util.NewObj("type", "file", "file_id", id), "cache_control", cc), nil
	case "text":
		return docMeta(p.ProviderOptions, p.Filename, cc, util.NewObj("type", "text", "media_type", "text/plain", "data", p.Data.Text)), nil
	}
	isURL := p.Data.Type == "url"
	urlSrc := func() *util.Obj { return util.NewObj("type", "url", "url", p.Data.URL) }
	top := llm.TopLevelMediaType(p.MediaType)
	if top == "image" {
		src := urlSrc()
		if !isURL {
			mt, err := llm.ResolveFullMediaType(p)
			if err != nil {
				return nil, err
			}
			src = util.NewObj("type", "base64", "media_type", mt, "data", llm.ToBase64(p.Data))
		}
		return util.NewObj("type", "image", "source", src, "cache_control", cc), nil
	}
	if top == "application" {
		isPDF := p.MediaType == "application/pdf"
		if !isURL {
			mt, err := llm.ResolveFullMediaType(p)
			if err != nil {
				return nil, err
			}
			isPDF = mt == "application/pdf"
		}
		if isPDF {
			betas.add("pdfs-2024-09-25")
			src := urlSrc()
			if !isURL {
				src = util.NewObj("type", "base64", "media_type", "application/pdf", "data", llm.ToBase64(p.Data))
			}
			return docMeta(p.ProviderOptions, p.Filename, cc, src), nil
		}
	}
	if p.MediaType == "text/plain" {
		src := urlSrc()
		if !isURL {
			src = util.NewObj("type", "text", "media_type", "text/plain", "data", bytesToString(p.Data))
		}
		return docMeta(p.ProviderOptions, p.Filename, cc, src), nil
	}
	return nil, llm.NewUnsupported("media type: " + p.MediaType)
}

func toolContentPart(c llm.Part, warnings *[]llm.Warning, betas *set) any {
	switch c.Type {
	case "text":
		return util.NewObj("type", "text", "text", c.Text)
	case "file":
		top := llm.TopLevelMediaType(c.MediaType)
		switch c.Data.Type {
		case "url":
			t := "document"
			if top == "image" {
				t = "image"
			}
			return util.NewObj("type", t, "source", util.NewObj("type", "url", "url", c.Data.URL))
		case "data":
			mt, _ := llm.ResolveFullMediaType(c)
			if top == "image" {
				return util.NewObj("type", "image", "source", util.NewObj("type", "base64", "media_type", mt, "data", llm.ToBase64(c.Data)))
			}
			if mt == "application/pdf" {
				betas.add("pdfs-2024-09-25")
				return util.NewObj("type", "document", "source", util.NewObj("type", "base64", "media_type", "application/pdf", "data", llm.ToBase64(c.Data)))
			}
			*warnings = append(*warnings, otherWarning("unsupported tool content part type: file with media type: "+c.MediaType))
			return nil
		}
		*warnings = append(*warnings, otherWarning("unsupported tool content part type: file with data type: "+c.Data.Type))
		return nil
	case "custom":
		a := anth(c.ProviderOptions)
		if get(a, "type") == "tool-reference" {
			return util.NewObj("type", "tool_reference", "tool_name", orUndef(get(a, "toolName")))
		}
		*warnings = append(*warnings, otherWarning("unsupported custom tool content part"))
		return nil
	}
	*warnings = append(*warnings, otherWarning("unsupported tool content part type: "+c.Type))
	return nil
}

func moveToolUseToEnd(content []any) []any {
	var out, seg []any
	flush := func() {
		var tu []any
		for _, x := range seg {
			if x.(*util.Obj).Get("type") == "tool_use" {
				tu = append(tu, x)
			} else {
				out = append(out, x)
			}
		}
		out = append(out, tu...)
		seg = nil
	}
	for _, x := range content {
		switch x.(*util.Obj).Get("type") {
		case "thinking", "redacted_thinking", "fallback":
			flush()
			out = append(out, x)
		default:
			seg = append(seg, x)
		}
	}
	flush()
	return out
}
