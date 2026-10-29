package aisdk

import (
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// MissingToolResultsError: ai MissingToolResultsError.
type MissingToolResultsError struct{ ToolCallIDs []string }

func (e *MissingToolResultsError) Error() string {
	s := ""
	if len(e.ToolCallIDs) > 1 {
		s = "s"
	}
	return fmt.Sprintf("Tool result%s %s missing for tool call%s %s.", s, map[bool]string{true: "are", false: "is"}[len(e.ToolCallIDs) > 1], s, strings.Join(e.ToolCallIDs, ", "))
}
func (e *MissingToolResultsError) Name() string { return "AI_MissingToolResultsError" }

// convertToLanguageModelPrompt (instructions + ModelMessages → LanguageModelV4Prompt) for the
// part types this runtime produces (text / image / reasoning / tool-call / tool-result).
func convertPrompt(instructions *string, messages []*u.Obj) ([]any, error) {
	out := []any{}
	if instructions != nil {
		out = append(out, u.NewObj("role", "system", "content", *instructions))
	}
	// combine consecutive tool messages
	var combined []*u.Obj
	for _, m := range messages {
		if m.Get("role") == "tool" && len(combined) > 0 && combined[len(combined)-1].Get("role") == "tool" {
			last := combined[len(combined)-1]
			last.Set("content", append(append([]any{}, last.Get("content").([]any)...), m.Get("content").([]any)...))
			continue
		}
		if m.Get("role") == "tool" {
			m = u.NewObj("role", "tool", "content", append([]any{}, m.Get("content").([]any)...))
		}
		combined = append(combined, m)
	}
	pending := []string{}
	for _, m := range combined {
		switch m.Get("role") {
		case "assistant":
			if arr, ok := m.Get("content").([]any); ok {
				for _, p := range arr {
					if po := p.(*u.Obj); po.Get("type") == "tool-call" && po.Get("providerExecuted") != true {
						pending = appendUnique(pending, po.Get("toolCallId").(string))
					}
				}
			}
		case "tool":
			for _, p := range m.Get("content").([]any) {
				if po := p.(*u.Obj); po.Get("type") == "tool-result" {
					pending = remove(pending, po.Get("toolCallId").(string))
				}
			}
		case "user", "system":
			if len(pending) > 0 {
				return nil, &MissingToolResultsError{ToolCallIDs: pending}
			}
		}
	}
	if len(pending) > 0 {
		return nil, &MissingToolResultsError{ToolCallIDs: pending}
	}
	for _, m := range combined {
		if m.Get("role") == "tool" && len(m.Get("content").([]any)) == 0 {
			continue
		}
		out = append(out, convertMessage(m))
	}
	return out, nil
}

func appendUnique(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func remove(s []string, v string) []string {
	r := s[:0:0]
	for _, x := range s {
		if x != v {
			r = append(r, x)
		}
	}
	return r
}

func setIf(o *u.Obj, k string, v any) {
	if v != nil {
		o.Set(k, v)
	}
}

func convertMessage(m *u.Obj) *u.Obj {
	role := m.Get("role").(string)
	switch role {
	case "system":
		return u.NewObj("role", "system", "content", m.Get("content"))
	case "user", "assistant":
		if s, ok := m.Get("content").(string); ok {
			return u.NewObj("role", role, "content", []any{u.NewObj("type", "text", "text", s)})
		}
		parts := []any{}
		for _, p := range m.Get("content").([]any) {
			po := p.(*u.Obj)
			typ := po.Get("type")
			if typ == "text" && po.Get("text") == "" && (role == "user" || po.Get("providerOptions") == nil) {
				continue
			}
			var c *u.Obj
			switch typ {
			case "text":
				c = u.NewObj("type", "text", "text", po.Get("text"))
			case "image":
				c = u.NewObj("type", "file", "mediaType", po.Get("mediaType"), "data", u.NewObj("type", "data", "data", po.Get("image")))
			case "reasoning":
				c = u.NewObj("type", "reasoning", "text", po.Get("text"))
			case "tool-call":
				c = u.NewObj("type", "tool-call", "toolCallId", po.Get("toolCallId"), "toolName", po.Get("toolName"), "input", po.Get("input"))
				setIf(c, "providerExecuted", po.Get("providerExecuted"))
			case "tool-result":
				c = u.NewObj("type", "tool-result", "toolCallId", po.Get("toolCallId"), "toolName", po.Get("toolName"), "output", po.Get("output"))
			default:
				c = po
			}
			setIf(c, "providerOptions", po.Get("providerOptions"))
			parts = append(parts, c)
		}
		return u.NewObj("role", role, "content", parts)
	case "tool":
		parts := []any{}
		for _, p := range m.Get("content").([]any) {
			po := p.(*u.Obj)
			c := u.NewObj("type", "tool-result", "toolCallId", po.Get("toolCallId"), "toolName", po.Get("toolName"), "output", po.Get("output"))
			setIf(c, "providerOptions", po.Get("providerOptions"))
			parts = append(parts, c)
		}
		return u.NewObj("role", "tool", "content", parts)
	}
	return m
}

/* ------------------------------ parseToolCall ------------------------------ */

var (
	suspectProto       = regexp.MustCompile(`"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:`)
	suspectConstructor = regexp.MustCompile(`"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:`)
)

// secureJSONParse: provider-utils secureJsonParse (JSON.parse + prototype-poisoning scan).
func secureJSONParse(text string) (any, error) {
	if _, err := charcontract.ParseJSON(text); err != nil {
		return nil, &llm.SyntaxError{Message: err.Error()}
	}
	v, err := u.ParseString(text)
	if err != nil {
		return nil, &llm.SyntaxError{Message: err.Error()}
	}
	switch v.(type) {
	case *u.Obj, []any:
	default:
		return v, nil
	}
	if !suspectProto.MatchString(text) && !suspectConstructor.MatchString(text) {
		return v, nil
	}
	next := []any{v}
	for len(next) > 0 {
		nodes := next
		next = nil
		for _, n := range nodes {
			var vals []any
			switch x := n.(type) {
			case *u.Obj:
				if x.Has("__proto__") {
					return nil, &llm.SyntaxError{Message: "Object contains forbidden prototype property"}
				}
				if c, ok := x.Get("constructor").(*u.Obj); ok && c.Has("prototype") {
					return nil, &llm.SyntaxError{Message: "Object contains forbidden prototype property"}
				}
				for _, k := range x.Keys() {
					vals = append(vals, x.Get(k))
				}
			case []any:
				vals = x
			}
			for _, e := range vals {
				switch e.(type) {
				case *u.Obj, []any:
					next = append(next, e)
				}
			}
		}
	}
	return v, nil
}

func safeParseJSON(text string) (any, error) {
	v, err := secureJSONParse(text)
	if err != nil {
		return nil, &llm.JSONParseError{Text: text, Cause: err}
	}
	return v, nil
}

// parsedCall: a parsed (possibly invalid) tool call of a step.
type parsedCall struct {
	ToolCallID, ToolName string
	Input                any
	Invalid              bool
	Err                  error
	ProviderExecuted     any
}

// parseToolCall (no repairToolCall / refineToolInput configured by the runtime).
func parseToolCall(raw llm.StreamPart, p *TextParams) parsedCall {
	id, name, input := raw.ToolCallID, raw.ToolName, raw.Input
	c := parsedCall{ToolCallID: id, ToolName: name}
	if raw.ProviderExecuted != nil {
		c.ProviderExecuted = *raw.ProviderExecuted
	}
	var err error
	if !p.HasTools {
		err = &NoSuchToolError{Message: "Model tried to call unavailable tool '" + name + "'. No tools are available.", ToolName: name}
	} else if t := p.tool(name); t == nil {
		names := make([]string, len(p.Tools))
		for i, t := range p.Tools {
			names[i] = t.Name
		}
		err = &NoSuchToolError{Message: "Model tried to call unavailable tool '" + name + "'. Available tools: " + strings.Join(names, ", ") + ".", ToolName: name}
	} else if u.JSTrim(input) == "" {
		c.Input = u.NewObj()
		return c
	} else if v, e := safeParseJSON(input); e != nil {
		err = &InvalidToolInputError{Message: "Invalid input for tool " + name + ": " + GetErrorMessage(e), ToolName: name, ToolInput: input, Cause: e}
	} else {
		c.Input = v
		return c
	}
	if v, e := safeParseJSON(input); e == nil {
		c.Input = v
	} else {
		c.Input = input
	}
	c.Invalid, c.Err = true, err
	return c
}
