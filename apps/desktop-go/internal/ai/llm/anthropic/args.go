package anthropic

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type prepared struct {
	args         *util.Obj
	warnings     []llm.Warning
	betas        set
	usesJSONTool bool
}

var providerToolNames = map[string]string{
	"anthropic.code_execution_20250522": "code_execution", "anthropic.code_execution_20250825": "code_execution",
	"anthropic.code_execution_20260120": "code_execution", "anthropic.computer_20241022": "computer",
	"anthropic.computer_20250124": "computer", "anthropic.computer_20251124": "computer",
	"anthropic.computer_toolset_20260801": "computer", "anthropic.text_editor_20241022": "str_replace_editor",
	"anthropic.text_editor_20250124": "str_replace_editor", "anthropic.text_editor_20250429": "str_replace_based_edit_tool",
	"anthropic.text_editor_20250728": "str_replace_based_edit_tool", "anthropic.bash_20241022": "bash",
	"anthropic.bash_20250124": "bash", "anthropic.memory_20250818": "memory",
	"anthropic.web_search_20250305": "web_search", "anthropic.web_search_20260209": "web_search",
	"anthropic.web_search_20260318": "web_search", "anthropic.web_fetch_20250910": "web_fetch",
	"anthropic.web_fetch_20260209": "web_fetch", "anthropic.web_fetch_20260318": "web_fetch",
	"anthropic.tool_search_regex_20251119": "tool_search_tool_regex", "anthropic.tool_search_bm25_20251119": "tool_search_tool_bm25",
	"anthropic.advisor_20260301": "advisor",
}

func unsup(feature, details string) llm.Warning {
	return llm.Warning{Type: "unsupported", Feature: feature, Details: &details}
}

func compat(feature, details string) llm.Warning {
	return llm.Warning{Type: "compatibility", Feature: feature, Details: &details}
}

func fmtN(f float64) string { return util.FormatNumber(f) }

func jsRound(x float64) float64 { return math.Floor(float64(x) + 0.5) }

// resolveReasoning is resolveAnthropicReasoningConfig; returns (thinking, effort).
func resolveReasoning(r, modelID string, c capabilities, w *[]llm.Warning) (thinking *util.Obj, effort any, ok bool) {
	if r == "none" {
		if c.supportsBetweenToolsThinking {
			return util.NewObj("type", "between_tools"), nil, true
		}
		if c.rejectsThinkingDisabled {
			*w = append(*w, compat("reasoning", "reasoning 'none' is not supported by "+modelID+"; it always uses adaptive thinking. Using effort 'low' to minimize thinking instead."))
			return nil, "low", true
		}
		return util.NewObj("type", "disabled"), nil, true
	}
	if c.supportsAdaptiveThinking {
		xh := "max"
		if c.supportsXhighEffort {
			xh = "xhigh"
		}
		m := map[string]string{"minimal": "low", "low": "low", "medium": "medium", "high": "high", "xhigh": xh, "max": "max"}
		mapped, found := m[r]
		if !found {
			*w = append(*w, unsup("reasoning", `reasoning "`+r+`" is not supported by this model.`))
			effort = nil
		} else {
			if mapped != r {
				*w = append(*w, compat("reasoning", `reasoning "`+r+`" is not directly supported by this model. mapped to effort "`+mapped+`".`))
			}
			effort = mapped
		}
		return util.NewObj("type", "adaptive", "display", "summarized"), effort, true
	}
	pct := map[string]float64{"minimal": .02, "low": .1, "medium": .3, "high": .6, "xhigh": .9, "max": .95}
	p, found := pct[r]
	if !found {
		*w = append(*w, unsup("reasoning", `reasoning "`+r+`" is not supported by this model.`))
		return nil, nil, false
	}
	mx := c.maxOutputTokens
	b := math.Min(mx, math.Max(1024, jsRound(mx*p)))
	return util.NewObj("type", "enabled", "budgetTokens", b), nil, true
}

func (m *MessagesModel) prepareRequest(o llm.CallOptions, stream bool, userBetas []string) (*prepared, error) {
	var w []llm.Warning
	modelID := m.modelID
	temperature, topP, topK := o.Temperature, o.TopP, o.TopK
	if o.FrequencyPenalty != nil {
		w = append(w, llm.Warning{Type: "unsupported", Feature: "frequencyPenalty"})
	}
	if o.PresencePenalty != nil {
		w = append(w, llm.Warning{Type: "unsupported", Feature: "presencePenalty"})
	}
	if o.Seed != nil {
		w = append(w, llm.Warning{Type: "unsupported", Feature: "seed"})
	}
	if temperature != nil && *temperature > 1 {
		w = append(w, unsup("temperature", fmtN(*temperature)+" exceeds anthropic maximum of 1.0. clamped to 1.0"))
		temperature = pf(1)
	} else if temperature != nil && *temperature < 0 {
		w = append(w, unsup("temperature", fmtN(*temperature)+" is below anthropic minimum of 0. clamped to 0"))
		temperature = pf(0)
	}
	rf := o.ResponseFormat
	isJSON := rf != nil && rf.Type == "json"
	hasSchema := isJSON && rf.Schema != nil
	if isJSON && rf.Schema == nil {
		w = append(w, unsup("responseFormat", "JSON response format requires a schema. The response format is ignored."))
	}
	parsed, err := parseOptions(o.ProviderOptions)
	if err != nil {
		return nil, err
	}
	ao := util.NewObj()
	if parsed != nil {
		ao = parsed.Clone()
	}
	c := getModelCapabilities(modelID)
	if !c.isKnownModel && o.MaxOutputTokens == nil {
		w = append(w, compat("maxOutputTokens", `The model "`+modelID+`" is unknown. The max output tokens have been limited to `+fmtN(c.maxOutputTokens)+`. Set maxOutputTokens explicitly to override this limit.`))
	}
	if c.rejectsSamplingParameters {
		if temperature != nil {
			w = append(w, unsup("temperature", "temperature is not supported by "+modelID+" and will be ignored"))
			temperature = nil
		}
		if topK != nil {
			w = append(w, unsup("topK", "topK is not supported by "+modelID+" and will be ignored"))
			topK = nil
		}
		if topP != nil {
			w = append(w, unsup("topP", "topP is not supported by "+modelID+" and will be ignored"))
			topP = nil
		}
	}
	isAnthropicModel := c.isKnownModel || strings.Contains(modelID, "claude-")
	supportsSO, supportsStrict := c.supportsStructuredOutput, c.supportsStructuredOutput
	mode, _ := get(ao, "structuredOutputMode").(string)
	if mode == "" {
		mode = "auto"
	}
	useSO := mode == "outputFormat" || (mode == "auto" && supportsSO)
	if !useSO && c.rejectsForcedToolUse && supportsSO && hasSchema {
		w = append(w, unsup("providerOptions.anthropic.structuredOutputMode", "structuredOutputMode 'jsonTool' is not supported by "+modelID+" because it rejects forced tool use. Using 'outputFormat' instead."))
		useSO = true
	}
	var jsonTool *llm.Tool
	if hasSchema && !useSO {
		d := "Respond with a JSON object."
		jsonTool = &llm.Tool{Type: "function", Name: "json", Description: &d, InputSchema: rf.Schema}
	}
	if jsonTool != nil && get(ao, "disableParallelToolUse") == false {
		w = append(w, unsup("providerOptions.anthropic.disableParallelToolUse", "`disableParallelToolUse: false` is ignored when using the JSON response tool. Parallel tool use is disabled to ensure a single coherent JSON tool call."))
	}
	cm, compaction := objAt(ao, "contextManagement"), objAt(ao, "compaction")
	if cm != nil && compaction != nil {
		return nil, &llm.InvalidArgumentError{Argument: "providerOptions", Message: "Anthropic provider options `compaction` and `contextManagement` cannot be used together."}
	}
	validator := &cacheValidator{}
	nameMap := map[string]string{}
	for _, t := range o.Tools {
		if t.Type == "provider" {
			if pn, ok := providerToolNames[t.ID]; ok {
				nameMap[t.Name] = pn
			}
		}
	}
	sendReasoning := true
	if b, ok := get(ao, "sendReasoning").(bool); ok {
		sendReasoning = b
	}
	conv, err := convertPrompt(o.Prompt, convertCtx{
		sendReasoning: sendReasoning, warnings: &w, validator: validator,
		toProvider: func(n string) string {
			if pn, ok := nameMap[n]; ok {
				return pn
			}
			return n
		},
	})
	if err != nil {
		return nil, err
	}
	betas := conv.betas

	thinkingOf := func() *util.Obj { return objAt(ao, "thinking") }
	thinkingType := func() any { return get(thinkingOf(), "type") }
	if o.Reasoning != "" && o.Reasoning != "provider-default" && get(ao, "effort") == nil {
		th, eff, ok := resolveReasoning(o.Reasoning, modelID, c, &w)
		if ok {
			if thinkingOf() == nil && th != nil {
				ao.Set("thinking", th)
			}
			if eff != nil && thinkingType() != "disabled" {
				ao.Set("effort", eff)
			}
		}
	}
	if c.rejectsThinkingDisabled && thinkingOf() != nil {
		if thinkingType() == "disabled" && c.supportsBetweenToolsThinking {
			w = append(w, unsup("providerOptions.anthropic.thinking", "thinking cannot be disabled for "+modelID+". Using 'between_tools' thinking, the lowest thinking setting, instead."))
			ao.Set("thinking", util.NewObj("type", "between_tools"))
		} else if thinkingType() == "disabled" {
			w = append(w, unsup("providerOptions.anthropic.thinking", "thinking cannot be disabled for "+modelID+"; it always uses adaptive thinking. The thinking setting has been removed. Lower 'effort' to reduce thinking."))
			ao.Delete("thinking")
		}
	}
	if c.rejectsBudgetThinking && thinkingType() == "enabled" {
		d := "budget-based thinking is not supported by " + modelID + ". Using adaptive thinking instead. Use 'effort' to control how much the model thinks."
		if c.rejectsThinkingDisabled {
			d = "budget-based thinking is not supported by " + modelID + "; it always uses adaptive thinking. Using adaptive thinking instead. Use 'effort' to control how much the model thinks."
		}
		w = append(w, unsup("providerOptions.anthropic.thinking", d))
		ao.Set("thinking", util.NewObj("type", "adaptive"))
	}
	effort := func() any { return get(ao, "effort") }
	if c.rejectsThinkingDisabledAboveHighEffort && thinkingType() == "disabled" && (effort() == "xhigh" || effort() == "max") {
		w = append(w, unsup("providerOptions.anthropic.effort", "effort '"+effort().(string)+"' is not supported by "+modelID+" when thinking is disabled. The effort has been lowered to 'high'."))
		ao.Set("effort", "high")
	}
	if thinkingType() == "between_tools" && (effort() == "xhigh" || effort() == "max") {
		w = append(w, unsup("providerOptions.anthropic.effort", "effort '"+effort().(string)+"' is not supported with 'between_tools' thinking. The effort has been lowered to 'high'."))
		ao.Set("effort", "high")
	}

	tt, _ := thinkingType().(string)
	isThinking := tt == "enabled" || tt == "adaptive" || tt == "between_tools"
	var binding *util.Obj
	if th := thinkingOf(); th != nil && th.Has("blockBinding") {
		binding = objAt(th, "blockBinding")
	}
	sendThinking := isThinking || tt == "disabled" || binding != nil
	var budget *float64
	if tt == "enabled" {
		if b, ok := get(thinkingOf(), "budgetTokens").(float64); ok {
			budget = &b
		}
	}
	var display any
	if tt == "adaptive" {
		display = get(thinkingOf(), "display")
	}
	maxTokens := c.maxOutputTokens
	if o.MaxOutputTokens != nil {
		maxTokens = *o.MaxOutputTokens
	}

	args := util.NewObj("model", modelID, "max_tokens", maxTokens,
		"temperature", numOrUndef(temperature), "top_k", numOrUndef(topK), "top_p", numOrUndef(topP))
	if o.StopSequences != nil {
		ss := make([]any, len(o.StopSequences))
		for i, s := range o.StopSequences {
			ss[i] = s
		}
		args.Set("stop_sequences", ss)
	} else {
		args.Set("stop_sequences", util.Undefined)
	}
	if sendThinking {
		th := util.NewObj()
		if tt != "" {
			th.Set("type", tt)
		}
		if budget != nil {
			th.Set("budget_tokens", *budget)
		}
		if display != nil {
			th.Set("display", display)
		}
		if binding != nil {
			th.Set("block_binding", util.NewObj("prefix_mismatch_behavior", get(binding, "prefixMismatchBehavior")))
		}
		args.Set("thinking", th)
	}
	tb := objAt(ao, "taskBudget")
	useFormat := useSO && hasSchema
	if util.Truthy(effort()) || tb != nil || useFormat {
		oc := util.NewObj()
		if util.Truthy(effort()) {
			oc.Set("effort", effort())
		}
		if tb != nil {
			t := util.NewObj("type", get(tb, "type"), "total", get(tb, "total"))
			if r := get(tb, "remaining"); r != nil {
				t.Set("remaining", r)
			}
			oc.Set("task_budget", t)
		}
		if useFormat {
			oc.Set("format", util.NewObj("type", "json_schema", "schema", sanitizeJSONSchema(rf.Schema)))
		}
		args.Set("output_config", oc)
	}
	for _, kv := range [][2]string{{"speed", "speed"}, {"serviceTier", "service_tier"}, {"inferenceGeo", "inference_geo"}} {
		if v := get(ao, kv[0]); util.Truthy(v) {
			args.Set(kv[1], v)
		}
	}
	fb := get(ao, "fallbacks")
	fbArr, _ := fb.([]any)
	if fb == "default" || len(fbArr) > 0 {
		args.Set("fallbacks", fb)
	}
	if v := get(ao, "cacheControl"); v != nil {
		args.Set("cache_control", v)
	}
	if uid := get(objAt(ao, "metadata"), "userId"); uid != nil {
		args.Set("metadata", util.NewObj("user_id", uid))
	}
	mcp, _ := get(ao, "mcpServers").([]any)
	if len(mcp) > 0 {
		list := make([]any, len(mcp))
		for i, x := range mcp {
			s := asObj(x)
			tc := any(util.Undefined)
			if t := objAt(s, "toolConfiguration"); t != nil {
				tc = util.NewObj("allowed_tools", orUndef(get(t, "allowedTools")), "enabled", orUndef(get(t, "enabled")))
			}
			list[i] = util.NewObj("type", get(s, "type"), "name", get(s, "name"), "url", get(s, "url"),
				"authorization_token", orUndef(get(s, "authorizationToken")), "tool_configuration", tc)
		}
		args.Set("mcp_servers", list)
	}
	container := objAt(ao, "container")
	skills, _ := get(container, "skills").([]any)
	if container != nil {
		if len(skills) > 0 {
			list := make([]any, len(skills))
			for i, x := range skills {
				s := asObj(x)
				id := get(s, "skillId")
				if get(s, "type") == "custom" {
					ref, _ := get(objAt(s, "providerReference"), "anthropic").(string)
					if ref == "" && !objAt(s, "providerReference").Has("anthropic") {
						return nil, &llm.InvalidArgumentError{Argument: "reference", Message: "No provider reference found for provider 'anthropic'"}
					}
					id = ref
				}
				list[i] = util.NewObj("type", get(s, "type"), "skill_id", id, "version", orUndef(get(s, "version")))
			}
			args.Set("container", util.NewObj("id", orUndef(get(container, "id")), "skills", list))
		} else {
			args.Set("container", orUndef(get(container, "id")))
		}
	}
	args.Set("system", conv.system)
	args.Set("messages", conv.messages)
	sg, _ := get(ao, "safeguards").([]any)
	if len(sg) > 0 {
		list := make([]any, len(sg))
		for i, x := range sg {
			s := asObj(x)
			n := util.NewObj("type", get(s, "type"))
			if s.Has("classifierContext") && s.Get("classifierContext") != util.Undefined {
				n.Set("classifier_context", s.Get("classifierContext"))
			}
			list[i] = n
		}
		args.Set("safeguards", list)
	}
	if compaction != nil {
		n := util.NewObj("type", get(compaction, "type"))
		if v := get(compaction, "instructions"); v != nil {
			n.Set("instructions", v)
		}
		args.Set("compaction", n)
	}
	hasCompactEdit := false
	if cm != nil {
		edits, _ := get(cm, "edits").([]any)
		out := []any{}
		ren := map[string]string{"clearAtLeast": "clear_at_least", "clearToolInputs": "clear_tool_inputs",
			"excludeTools": "exclude_tools", "pauseAfterCompaction": "pause_after_compaction"}
		keys := map[string][]string{
			"clear_tool_uses_20250919": {"trigger", "keep", "clearAtLeast", "clearToolInputs", "excludeTools"},
			"clear_thinking_20251015":  {"keep"},
			"compact_20260112":         {"trigger", "pauseAfterCompaction", "instructions"},
		}
		for _, x := range edits {
			e := asObj(x)
			t, _ := get(e, "type").(string)
			if t == "compact_20260112" {
				hasCompactEdit = true
			}
			n := util.NewObj("type", t)
			for _, k := range keys[t] {
				if v := get(e, k); v != nil {
					nk := k
					if r, ok := ren[k]; ok {
						nk = r
					}
					n.Set(nk, v)
				}
			}
			out = append(out, n)
		}
		args.Set("context_management", util.NewObj("edits", out))
	}

	if isThinking {
		if tt == "enabled" && budget == nil {
			w = append(w, compat("extended thinking", "thinking budget is required when thinking is enabled. using default budget of 1024 tokens."))
			args.Set("thinking", util.NewObj("type", "enabled", "budget_tokens", float64(1024)))
			budget = pf(1024)
		}
		if temperature != nil {
			args.Set("temperature", util.Undefined)
			w = append(w, unsup("temperature", "temperature is not supported when thinking is enabled"))
		}
		if topK != nil {
			args.Set("top_k", util.Undefined)
			w = append(w, unsup("topK", "topK is not supported when thinking is enabled"))
		}
		if topP != nil {
			args.Set("top_p", util.Undefined)
			w = append(w, unsup("topP", "topP is not supported when thinking is enabled"))
		}
		b := 0.0
		if budget != nil {
			b = *budget
		}
		args.Set("max_tokens", maxTokens+b)
	} else if isAnthropicModel && topP != nil && temperature != nil {
		w = append(w, unsup("topP", "topP is not supported when temperature is set. topP is ignored."))
		args.Set("top_p", util.Undefined)
	}
	if mt := args.Get("max_tokens").(float64); c.isKnownModel && mt > c.maxOutputTokens {
		if o.MaxOutputTokens != nil {
			w = append(w, unsup("maxOutputTokens", fmtN(mt)+" (maxOutputTokens + thinkingBudget) is greater than "+modelID+" "+fmtN(c.maxOutputTokens)+" max output tokens. The max output tokens have been limited to "+fmtN(c.maxOutputTokens)+"."))
		}
		args.Set("max_tokens", c.maxOutputTokens)
	}

	if len(mcp) > 0 {
		betas.add("mcp-client-2025-04-04")
	}
	if len(sg) > 0 {
		betas.add("dangerous-tool-use-2026-09-03")
	}
	if compaction != nil {
		betas.add("compact-2026-09-04")
	}
	if cm != nil {
		betas.add("context-management-2025-06-27")
		if hasCompactEdit {
			betas.add("compact-2026-01-12")
		}
	}
	if container != nil && len(skills) > 0 {
		betas.add("code-execution-2025-08-25", "skills-2025-10-02", "files-api-2025-04-14")
		hasCE := false
		for _, t := range o.Tools {
			if t.Type == "provider" && (t.ID == "anthropic.code_execution_20250825" || t.ID == "anthropic.code_execution_20260120") {
				hasCE = true
			}
		}
		if !hasCE {
			w = append(w, otherWarning("code execution tool is required when using skills"))
		}
	}
	if tb != nil {
		betas.add("task-budgets-2026-03-13")
	}
	if get(ao, "speed") == "fast" {
		betas.add("fast-mode-2026-02-01")
	}
	if display == "updates" {
		betas.add("thinking-display-updates-2026-08-18")
	}
	if binding != nil {
		betas.add("thinking-binding-controls-2026-08-01")
	}
	if fb == "default" {
		betas.add("server-side-fallback-2026-07-01")
	} else if len(fbArr) > 0 {
		betas.add("server-side-fallback-2026-06-01")
	}

	eager := stream
	if b, ok := get(ao, "toolStreaming").(bool); ok {
		eager = stream && b
	}
	ti := toolsIn{tools: o.Tools, choice: o.ToolChoice, validator: validator, supportsSO: supportsSO,
		supportsStrict: supportsStrict, defaultEager: eager, rejectsForced: c.rejectsForcedToolUse}
	if b, ok := get(ao, "disableParallelToolUse").(bool); ok {
		ti.disableParallel = &b
	}
	if jsonTool != nil {
		ti.tools = append(append([]llm.Tool{}, o.Tools...), *jsonTool)
		ti.choice = &llm.ToolChoice{Type: "required"}
		t := true
		ti.disableParallel = &t
		ti.supportsSO = false
	}
	to, err := prepareTools(ti)
	if err != nil {
		return nil, err
	}
	args.Set("tools", to.tools)
	args.Set("tool_choice", to.choice)
	if stream {
		args.Set("stream", true)
	} else {
		args.Set("stream", util.Undefined)
	}
	w = append(append(w, to.warnings...), validator.warnings...)
	betas.add(to.betas.items...)
	betas.add(userBetas...)
	if ab, ok := get(ao, "anthropicBeta").([]any); ok {
		for _, x := range ab {
			betas.add(x.(string))
		}
	}
	return &prepared{args: args, warnings: w, betas: betas, usesJSONTool: jsonTool != nil}, nil
}
