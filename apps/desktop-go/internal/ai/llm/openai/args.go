package openai

import (
	"slices"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const topLogprobsMax = 20

// optionsSchema is openaiLanguageModelResponsesOptionsSchema.
var optionsSchema = llm.Obj(
	llm.F{Key: "conversation", S: llm.Nullish(llm.Str())},
	llm.F{Key: "include", S: llm.Nullish(llm.Arr(llm.Enum("reasoning.encrypted_content", "file_search_call.results", "web_search_call.results", "message.output_text.logprobs")))},
	llm.F{Key: "includeWebSearchSources", S: llm.Optional(llm.Bool())},
	llm.F{Key: "instructions", S: llm.Nullish(llm.Str())},
	llm.F{Key: "logprobs", S: llm.Optional(llm.Union(llm.Bool(), llm.Number()))}, // min(1).max(20) checked in parseOptions
	llm.F{Key: "maxToolCalls", S: llm.Nullish(llm.Number())},
	llm.F{Key: "metadata", S: llm.Nullish(llm.Any())},
	llm.F{Key: "parallelToolCalls", S: llm.Nullish(llm.Bool())},
	llm.F{Key: "previousResponseId", S: llm.Nullish(llm.Str())},
	llm.F{Key: "promptCacheKey", S: llm.Nullish(llm.Str())},
	llm.F{Key: "promptCacheOptions", S: llm.Optional(llm.Obj(
		llm.F{Key: "mode", S: llm.Optional(llm.Enum("implicit", "explicit"))},
		llm.F{Key: "ttl", S: llm.Optional(llm.Lit("30m"))},
	))},
	llm.F{Key: "promptCacheRetention", S: llm.Nullish(llm.Enum("in_memory", "24h"))},
	llm.F{Key: "reasoningEffort", S: llm.Nullish(llm.Str())},
	llm.F{Key: "reasoningEffortUpdate", S: llm.Optional(llm.Enum("none", "low", "medium", "high", "xhigh", "max"))},
	llm.F{Key: "reasoningMode", S: llm.Optional(llm.Enum("standard", "pro"))},
	llm.F{Key: "reasoningContext", S: llm.Optional(llm.Enum("auto", "current_turn", "all_turns"))},
	llm.F{Key: "reasoningSummary", S: llm.Nullish(llm.Str())},
	llm.F{Key: "safetyIdentifier", S: llm.Nullish(llm.Str())},
	llm.F{Key: "serviceTier", S: llm.Nullish(llm.Enum("auto", "flex", "priority", "fast", "ultrafast", "default"))},
	llm.F{Key: "store", S: llm.Nullish(llm.Bool())},
	llm.F{Key: "passThroughUnsupportedFiles", S: llm.Optional(llm.Bool())},
	llm.F{Key: "strictJsonSchema", S: llm.Nullish(llm.Bool())},
	llm.F{Key: "textVerbosity", S: llm.Nullish(llm.Enum("low", "medium", "high"))},
	llm.F{Key: "truncation", S: llm.Nullish(llm.Enum("auto", "disabled"))},
	llm.F{Key: "user", S: llm.Nullish(llm.Str())},
	llm.F{Key: "systemMessageMode", S: llm.Optional(llm.Enum("system", "developer", "remove"))},
	llm.F{Key: "forceReasoning", S: llm.Optional(llm.Bool())},
	llm.F{Key: "contextManagement", S: llm.Nullish(llm.Arr(llm.Obj(
		llm.F{Key: "type", S: llm.Lit("compaction")},
		llm.F{Key: "compactThreshold", S: llm.Number()},
	)))},
	llm.F{Key: "compactionTrigger", S: llm.Optional(llm.Bool())},
	llm.F{Key: "allowedTools", S: llm.Optional(llm.Obj(
		llm.F{Key: "toolNames", S: llm.Arr(llm.Str())},
		llm.F{Key: "mode", S: llm.Optional(llm.Enum("auto", "required"))},
	))},
)

func parseOptions(provider string, po *util.Obj) (*util.Obj, error) {
	v := get(po, provider)
	if v == nil {
		return nil, nil
	}
	bad := &llm.InvalidArgumentError{Argument: "providerOptions", Message: "invalid " + provider + " provider options"}
	out, err := llm.Validate(v, optionsSchema)
	if err != nil {
		return nil, bad
	}
	o := out.(*util.Obj)
	if n, ok := o.Get("logprobs").(float64); ok && (n < 1 || n > topLogprobsMax) {
		return nil, bad
	}
	if at := objAt(o, "allowedTools"); at != nil && len(at.Get("toolNames").([]any)) < 1 {
		return nil, bad
	}
	return o, nil
}

// opt is `openaiOptions?.k` (undefined when absent; null kept).
func opt(o *util.Obj, k string) any {
	if o == nil || !o.Has(k) {
		return util.Undefined
	}
	return o.Get(k)
}

// nn reports `openaiOptions?.k != null`.
func nn(o *util.Obj, k string) bool { return get(o, k) != nil }

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return v != util.Undefined
}

type args struct {
	body     *util.Obj
	warnings []llm.Warning
	store    any
	optsName string
}

func unsup(feature, details string) llm.Warning {
	return llm.Warning{Type: "unsupported", Feature: feature, Details: sp(details)}
}

// getArgs is OpenAIResponsesLanguageModel.prepareRequest.
func (m *ResponsesModel) getArgs(o llm.CallOptions) (*args, error) {
	warnings := []llm.Warning{}
	caps := getCapabilities(m.modelID)
	if o.TopK != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "topK"})
	}
	if o.Seed != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "seed"})
	}
	if o.PresencePenalty != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "presencePenalty"})
	}
	if o.FrequencyPenalty != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "frequencyPenalty"})
	}
	if o.StopSequences != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "stopSequences"})
	}
	name := "openai"
	if strings.Contains(m.provider, "azure") {
		name = "azure"
	}
	op, err := parseOptions(name, o.ProviderOptions)
	if err != nil {
		return nil, err
	}
	if op == nil && name != "openai" {
		if op, err = parseOptions("openai", o.ProviderOptions); err != nil {
			return nil, err
		}
	}

	var effort any = util.Undefined
	if nn(op, "reasoningEffort") {
		effort = op.Get("reasoningEffort")
	} else if o.Reasoning != "" && o.Reasoning != "provider-default" {
		effort = o.Reasoning
	}
	effortSet := effort != util.Undefined
	if effortSet && caps.supportedReasoningEfforts != nil && !slices.Contains(caps.supportedReasoningEfforts, effort.(string)) {
		warnings = append(warnings, unsup("reasoningEffort", m.modelID+" only supports the following reasoning efforts: "+strings.Join(caps.supportedReasoningEfforts, ", ")))
		effort, effortSet = util.Undefined, false
	}
	var summary any = util.Undefined
	if op != nil && op.Has("reasoningSummary") {
		summary = op.Get("reasoningSummary")
	} else if effortSet && effort != "none" {
		summary = "detailed"
	}
	summarySet := summary != util.Undefined && summary != nil
	isReasoning := caps.isReasoningModel
	if b, ok := get(op, "forceReasoning").(bool); ok {
		isReasoning = b
	}
	if truthy(get(op, "conversation")) && truthy(get(op, "previousResponseId")) {
		warnings = append(warnings, unsup("conversation", "conversation and previousResponseId cannot be used together"))
	}
	if nn(op, "conversation") {
		return nil, llm.NewUnsupported("openai conversation option (Go runtime, D-B5-P-7)")
	}

	tools, toolChoice, toolWarnings, err := prepareTools(o.Tools, o.ToolChoice, caps.supportsAsyncToolCalling)
	if err != nil {
		return nil, err
	}
	if nn(op, "allowedTools") {
		return nil, llm.NewUnsupported("openai allowedTools option (Go runtime, D-B5-P-7)")
	}
	outputSchemaTools := map[string]bool{}
	for _, t := range o.Tools {
		if t.Type == "function" && get(objAt(t.ProviderOptions, "openai"), "outputSchema") != nil {
			outputSchemaTools[t.Name] = true
		}
	}

	var cfgReason string
	if !caps.supportsConfigurationUpdate {
		cfgReason = "reasoningEffortUpdate is only supported by GPT-6 and later models"
	} else if get(op, "reasoningMode") == "pro" || nn(op, "contextManagement") || get(op, "truncation") == "auto" {
		cfgReason = "reasoningEffortUpdate requires standard reasoning mode without automatic compaction or automatic truncation"
	}

	sysMode := caps.systemMessageMode
	if isReasoning {
		sysMode = "developer"
	}
	if s, ok := get(op, "systemMessageMode").(string); ok {
		sysMode = s
	}
	store := true
	if b, ok := get(op, "store").(bool); ok {
		store = b
	}
	pass, _ := get(op, "passThroughUnsupportedFiles").(bool)
	input, inWarn, err := convertInput(inputArgs{prompt: o.Prompt, systemMessageMode: sysMode, optionsName: name,
		fileIDPrefixes: m.fileIDPrefixes, store: store, hasPreviousID: nn(op, "previousResponseId"),
		passThroughFiles: pass, outputSchemaTools: outputSchemaTools})
	if err != nil {
		return nil, err
	}
	warnings = append(warnings, inWarn...)

	if upd, ok := get(op, "reasoningEffortUpdate").(string); ok {
		reason := cfgReason
		if reason == "" && caps.supportedReasoningEfforts != nil && !slices.Contains(caps.supportedReasoningEfforts, upd) {
			reason = m.modelID + " only supports the following reasoning efforts: " + strings.Join(caps.supportedReasoningEfforts, ", ")
		}
		if reason != "" {
			warnings = append(warnings, unsup("reasoningEffortUpdate", reason))
		} else {
			return nil, llm.NewUnsupported("reasoningEffortUpdate (Go runtime, D-B5-P-7)")
		}
	}
	if get(op, "compactionTrigger") == true {
		input = append(input, util.NewObj("type", "compaction_trigger"))
	}

	strict := true
	if b, ok := get(op, "strictJsonSchema").(bool); ok {
		strict = b
	}
	var normSchema any
	rf := o.ResponseFormat
	isJSON := rf != nil && rf.Type == "json"
	if isJSON && rf.Schema != nil {
		s, ws, err := normalizeJSONSchema(rf.Schema)
		if err != nil {
			return nil, err
		}
		normSchema = s
		warnings = append(warnings, ws...)
	}

	var include []any
	includeSet := false
	if inc, ok := get(op, "include").([]any); ok {
		include, includeSet = slices.Clone(inc), true
	}
	includeNull := op != nil && op.Has("include") && op.Get("include") == nil
	addInclude := func(k string) {
		if !includeSet {
			include, includeSet, includeNull = []any{k}, true, false
		} else if !slices.Contains(include, any(k)) {
			include = append(slices.Clone(include), k)
		}
	}
	var topLogprobs any = util.Undefined
	switch v := get(op, "logprobs").(type) {
	case float64:
		topLogprobs = v
	case bool:
		if v {
			topLogprobs = float64(topLogprobsMax)
		}
	}
	if truthy(topLogprobs) {
		addInclude("message.output_text.logprobs")
	}
	storeOpt := opt(op, "store")
	if storeOpt == false && isReasoning {
		addInclude("reasoning.encrypted_content")
	}

	body := util.NewObj("model", m.modelID, "input", input,
		"temperature", numOrUndef(o.Temperature), "top_p", numOrUndef(o.TopP), "max_output_tokens", numOrUndef(o.MaxOutputTokens))
	if isJSON || truthy(get(op, "textVerbosity")) {
		text := util.NewObj()
		if isJSON {
			if normSchema != nil {
				n := "response"
				if rf.Name != "" {
					n = rf.Name
				}
				var desc any = util.Undefined
				if rf.Description != "" {
					desc = rf.Description
				}
				text.Set("format", util.NewObj("type", "json_schema", "strict", strict, "name", n, "description", desc, "schema", normSchema))
			} else {
				text.Set("format", util.NewObj("type", "json_object"))
			}
		}
		if truthy(get(op, "textVerbosity")) {
			text.Set("verbosity", op.Get("textVerbosity"))
		}
		body.Set("text", text)
	}
	var includeV any = util.Undefined
	if includeSet {
		includeV = include
	} else if includeNull {
		includeV = nil
	}
	body.Set("conversation", opt(op, "conversation")).
		Set("max_tool_calls", opt(op, "maxToolCalls")).
		Set("metadata", opt(op, "metadata")).
		Set("parallel_tool_calls", opt(op, "parallelToolCalls")).
		Set("previous_response_id", opt(op, "previousResponseId")).
		Set("store", storeOpt).
		Set("user", opt(op, "user")).
		Set("instructions", opt(op, "instructions")).
		Set("service_tier", opt(op, "serviceTier")).
		Set("include", includeV).
		Set("prompt_cache_key", opt(op, "promptCacheKey")).
		Set("prompt_cache_options", opt(op, "promptCacheOptions")).
		Set("prompt_cache_retention", opt(op, "promptCacheRetention")).
		Set("safety_identifier", opt(op, "safetyIdentifier")).
		Set("top_logprobs", topLogprobs).
		Set("truncation", opt(op, "truncation"))
	if cm, ok := get(op, "contextManagement").([]any); ok {
		out := []any{}
		for _, x := range cm {
			c := x.(*util.Obj)
			out = append(out, util.NewObj("type", c.Get("type"), "compact_threshold", c.Get("compactThreshold")))
		}
		body.Set("context_management", out)
	}
	if isReasoning && (effortSet || summarySet || nn(op, "reasoningMode") || nn(op, "reasoningContext")) {
		r := util.NewObj()
		if effortSet {
			r.Set("effort", effort)
		}
		if summarySet {
			r.Set("summary", summary)
		}
		if nn(op, "reasoningMode") {
			r.Set("mode", op.Get("reasoningMode"))
		}
		if nn(op, "reasoningContext") {
			r.Set("context", op.Get("reasoningContext"))
		}
		body.Set("reasoning", r)
	}
	isNull := func(k string) bool { v := body.Get(k); return v == nil || v == util.Undefined }
	if caps.supportsConfigurationUpdate && !isNull("prompt_cache_retention") {
		body.Set("prompt_cache_retention", util.Undefined)
		warnings = append(warnings, unsup("promptCacheRetention", "promptCacheRetention is not supported by GPT-6 and later models; use promptCacheOptions instead"))
	}
	if isReasoning {
		if !(effort == "none" && caps.supportsNonReasoningParameters) {
			if !isNull("temperature") {
				body.Set("temperature", util.Undefined)
				warnings = append(warnings, unsup("temperature", "temperature is not supported for reasoning models"))
			}
			if !isNull("top_p") {
				body.Set("top_p", util.Undefined)
				warnings = append(warnings, unsup("topP", "topP is not supported for reasoning models"))
			}
			if caps.supportedReasoningEfforts != nil && (!isNull("top_logprobs") || (includeSet && slices.Contains(include, any("message.output_text.logprobs")))) {
				body.Set("top_logprobs", util.Undefined)
				if includeSet {
					f := []any{}
					for _, x := range include {
						if x != "message.output_text.logprobs" {
							f = append(f, x)
						}
					}
					if len(f) > 0 {
						body.Set("include", f)
					} else {
						body.Set("include", util.Undefined)
					}
				} else {
					body.Set("include", util.Undefined)
				}
				warnings = append(warnings, unsup("logprobs", "logprobs is not supported for reasoning models"))
			}
		}
	} else {
		for _, k := range [][2]string{{"reasoningEffort", "reasoningEffort"}, {"reasoningSummary", "reasoningSummary"}, {"reasoningMode", "reasoningMode"}, {"reasoningContext", "reasoningContext"}} {
			if nn(op, k[0]) {
				warnings = append(warnings, unsup(k[1], k[1]+" is not supported for non-reasoning models"))
			}
		}
	}
	tier := get(op, "serviceTier")
	if tier == "flex" && !caps.supportsFlexProcessing {
		warnings = append(warnings, unsup("serviceTier", "flex processing is only available for o3, o4-mini, and gpt-5 models"))
		body.Delete("service_tier")
	}
	if (tier == "priority" || tier == "fast") && !caps.supportsPriorityProcessing {
		warnings = append(warnings, unsup("serviceTier", "priority processing is only available for supported models (gpt-4, gpt-5, gpt-5-mini, o3, o4-mini) and requires Enterprise access. gpt-5-nano is not supported"))
		body.Delete("service_tier")
	}
	body.Set("tools", tools).Set("tool_choice", toolChoice)
	return &args{body: body, warnings: append(warnings, toolWarnings...), store: storeOpt, optsName: name}, nil
}
