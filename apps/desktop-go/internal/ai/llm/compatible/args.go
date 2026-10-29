package compatible

import (
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

var camelRe = regexp.MustCompile(`[_-][a-z]`)

// toCamelCase is utils/to-camel-case.ts toCamelCase.
func toCamelCase(s string) string {
	return camelRe.ReplaceAllStringFunc(s, func(g string) string { return strings.ToUpper(g[1:]) })
}

var chatOptionKeys = []string{"user", "reasoningEffort", "textVerbosity", "strictJsonSchema"}

var chatOptionsSchema = llm.Obj(
	llm.F{Key: "user", S: llm.Optional(llm.Str())},
	llm.F{Key: "reasoningEffort", S: llm.Optional(llm.Str())},
	llm.F{Key: "textVerbosity", S: llm.Optional(llm.Str())},
	llm.F{Key: "strictJsonSchema", S: llm.Optional(llm.Bool())},
)

func get(o *util.Obj, k string) any {
	if o == nil {
		return nil
	}
	return o.Get(k)
}

// parseProviderOptions is provider-utils parseProviderOptions.
func parseProviderOptions(provider string, po *util.Obj) (*util.Obj, error) {
	v := get(po, provider)
	if v == nil {
		return nil, nil
	}
	out, err := llm.Validate(v, chatOptionsSchema)
	if err != nil {
		return nil, &llm.InvalidArgumentError{Argument: "providerOptions", Message: "invalid " + provider + " provider options"}
	}
	return out.(*util.Obj), nil
}

func isCustomReasoning(r string) bool { return r != "" && r != "provider-default" }

func numOrUndef(n *float64) any {
	if n == nil {
		return util.Undefined
	}
	return *n
}

func orUndef(v any) any {
	if v == nil {
		return util.Undefined
	}
	return v
}

type args struct {
	body        *util.Obj
	warnings    []llm.Warning
	metadataKey string
}

func (m *ChatModel) getArgs(o llm.CallOptions) (*args, error) {
	var warnings []llm.Warning
	po := o.ProviderOptions
	name := m.optionsName()
	camel := toCamelCase(name)

	deprecated, err := parseProviderOptions("openai-compatible", po)
	if err != nil {
		return nil, err
	}
	if deprecated != nil {
		warnings = append(warnings, llm.Warning{Type: "deprecated", Setting: "providerOptions key 'openai-compatible'", Message: "Use 'openaiCompatible' instead."})
	}
	if camel != name && get(po, name) != nil {
		warnings = append(warnings, llm.Warning{Type: "deprecated", Setting: "providerOptions key '" + name + "'", Message: "Use '" + camel + "' instead."})
	}
	opts := util.NewObj()
	if deprecated != nil {
		opts = deprecated
	}
	for _, key := range []string{"openaiCompatible", name, camel} {
		p, err := parseProviderOptions(key, po)
		if err != nil {
			return nil, err
		}
		if p != nil {
			opts.Assign(p)
		}
	}
	strict := true
	if b, ok := opts.Get("strictJsonSchema").(bool); ok {
		strict = b
	}
	if o.TopK != nil {
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "topK"})
	}
	if o.ResponseFormat != nil && o.ResponseFormat.Type == "json" && o.ResponseFormat.Schema != nil {
		d := "JSON response format schema is only supported with structuredOutputs"
		warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "responseFormat", Details: &d})
	}
	tools, toolChoice, toolWarnings, err := prepareTools(o.Tools, o.ToolChoice)
	if err != nil {
		return nil, err
	}
	metadataKey := name
	if camel != name && get(po, camel) != nil {
		metadataKey = camel
	}

	b := util.NewObj()
	b.Set("model", m.modelID)
	b.Set("user", orUndef(opts.Get("user")))
	b.Set("max_tokens", numOrUndef(o.MaxOutputTokens))
	b.Set("temperature", numOrUndef(o.Temperature))
	b.Set("top_p", numOrUndef(o.TopP))
	b.Set("frequency_penalty", numOrUndef(o.FrequencyPenalty))
	b.Set("presence_penalty", numOrUndef(o.PresencePenalty))
	var rf any = util.Undefined
	if o.ResponseFormat != nil && o.ResponseFormat.Type == "json" {
		// supportsStructuredOutputs is false for Nomi's provider.
		_ = strict
		rf = util.NewObj("type", "json_object")
	}
	b.Set("response_format", rf)
	if o.StopSequences != nil {
		ss := make([]any, len(o.StopSequences))
		for i, s := range o.StopSequences {
			ss[i] = s
		}
		b.Set("stop", ss)
	} else {
		b.Set("stop", util.Undefined)
	}
	b.Set("seed", numOrUndef(o.Seed))
	extra := util.NewObj()
	for _, key := range []string{name, camel} {
		if src, ok := get(po, key).(*util.Obj); ok {
			extra.Assign(src)
		}
	}
	for _, k := range extra.Keys() {
		skip := false
		for _, ck := range chatOptionKeys {
			if k == ck {
				skip = true
			}
		}
		if !skip {
			v, _ := extra.Lookup(k)
			b.Set(k, v)
		}
	}
	var effort any = util.Undefined
	if v := opts.Get("reasoningEffort"); v != nil {
		effort = v
	} else if isCustomReasoning(o.Reasoning) {
		effort = o.Reasoning
	}
	b.Set("reasoning_effort", effort)
	b.Set("verbosity", orUndef(opts.Get("textVerbosity")))
	msgs, err := convertMessages(o.Prompt, metadataKey)
	if err != nil {
		return nil, err
	}
	b.Set("messages", msgs)
	b.Set("tools", tools)
	b.Set("tool_choice", toolChoice)
	return &args{body: b, warnings: append(warnings, toolWarnings...), metadataKey: metadataKey}, nil
}

func prepareTools(tools []llm.Tool, choice *llm.ToolChoice) (any, any, []llm.Warning, error) {
	var warnings []llm.Warning
	if len(tools) == 0 {
		return util.Undefined, util.Undefined, warnings, nil
	}
	out := []any{}
	for _, t := range tools {
		if t.Type == "provider" {
			warnings = append(warnings, llm.Warning{Type: "unsupported", Feature: "provider-defined tool " + t.ID})
			continue
		}
		f := util.NewObj("name", t.Name)
		if t.Description != nil {
			f.Set("description", *t.Description)
		} else {
			f.Set("description", util.Undefined)
		}
		f.Set("parameters", orUndef(t.InputSchema))
		if t.Strict != nil {
			f.Set("strict", *t.Strict)
		}
		out = append(out, util.NewObj("type", "function", "function", f))
	}
	if choice == nil {
		return out, util.Undefined, warnings, nil
	}
	switch choice.Type {
	case "auto", "none", "required":
		return out, choice.Type, warnings, nil
	case "tool":
		return out, util.NewObj("type", "function", "function", util.NewObj("name", choice.ToolName)), warnings, nil
	}
	return nil, nil, nil, llm.NewUnsupported("tool choice type: " + choice.Type)
}
