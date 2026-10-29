package server

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// ReasoningRejection is REASONING_REJECTION.
// ReasoningRejection is REASONING_REJECTION (JS \s mapped; [\s\S] is (?s:.)).
var ReasoningRejection = regexp.MustCompile(strings.NewReplacer("WSC", u.JSWS, "WS", u.JSWhitespace).Replace(`(?i)invalid_encrypted_content|(?:invalid|missing|mismatch|not valid|failed|cannot|unable|expected|required)(?s:.){0,100}(?:signature|encrypted_content|redacted_thinking)|(?:signature|encrypted_content|redacted_thinking)(?s:.){0,100}(?:invalid|missing|mismatch|not valid|failed|cannot|unable|required)|item(?:WS+withWS+id)?WS+['"]?rs_[^WSC'"]+['"]?WS+(?:wasWS+)?not found`))

// IsReasoningRejection is isReasoningRejection.
func IsReasoningRejection(status int, text string) bool {
	return (status == 400 || status == 404 || status == 422) && ReasoningRejection.MatchString(u.JSIText(text))
}

// HasSealedReasoning is hasSealedReasoning.
func HasSealedReasoning(wire string, body any) bool {
	_, changed := stripSealed(wire, body)
	return changed
}

// StripSealedReasoning is stripSealedReasoning (returns body itself when unchanged).
func StripSealedReasoning(wire string, body any) any {
	out, _ := stripSealed(wire, body)
	return out
}

func stripSealed(wire string, body any) (any, bool) {
	b, ok := body.(*u.Obj)
	if !ok || b == nil {
		return body, false
	}
	if msgs, ok := b.Get("messages").([]any); wire == "messages" && ok {
		changed := false
		out := make([]any, len(msgs))
		for i, m := range msgs {
			out[i] = m
			mo, ok := m.(*u.Obj)
			if !ok || mo == nil || mo.Get("role") != "assistant" {
				continue
			}
			content, ok := mo.Get("content").([]any)
			if !ok {
				continue
			}
			kept := []any{}
			for _, bl := range content {
				if bo, ok := bl.(*u.Obj); ok && bo != nil && (bo.Get("type") == "thinking" || bo.Get("type") == "redacted_thinking") {
					continue
				}
				kept = append(kept, bl)
			}
			if len(kept) == len(content) {
				continue
			}
			changed = true
			if len(kept) == 0 {
				kept = []any{u.NewObj("type", "text", "text", "(thinking omitted)")}
			}
			out[i] = mo.Clone().Set("content", kept)
		}
		if !changed {
			return body, false
		}
		return b.Clone().Set("messages", out), true
	}
	if in, ok := b.Get("input").([]any); wire == "responses" && ok {
		kept := []any{}
		for _, it := range in {
			if io, ok := it.(*u.Obj); ok && io != nil {
				t := io.Get("type")
				id, isS := io.Get("id").(string)
				if t == "reasoning" || (t == "item_reference" && isS && strings.HasPrefix(id, "rs_")) {
					continue
				}
			}
			kept = append(kept, it)
		}
		if len(kept) == len(in) {
			return body, false
		}
		return b.Clone().Set("input", kept), true
	}
	field, role := "", ""
	switch wire {
	case "chat":
		field, role = "messages", "assistant"
	case "gemini":
		field, role = "contents", "model"
	}
	if arr, ok := b.Get(field).([]any); field != "" && ok {
		changed := false
		out := make([]any, len(arr))
		for i, m := range arr {
			out[i] = m
			if mo, ok := m.(*u.Obj); ok && mo != nil && mo.Get("role") == role {
				if s, ch := stripSignatures(m); ch {
					out[i], changed = s, true
				}
			}
		}
		if !changed {
			return body, false
		}
		return b.Clone().Set(field, out), true
	}
	return body, false
}

func stripSignatures(v any) (any, bool) {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		changed := false
		for i, e := range x {
			var ch bool
			out[i], ch = stripSignatures(e)
			changed = changed || ch
		}
		if !changed {
			return v, false
		}
		return out, true
	case *u.Obj:
		if x == nil {
			return v, false
		}
		out := u.NewObj()
		changed := false
		for _, k := range x.Keys() {
			e := x.Get(k)
			if k == "thought_signature" || k == "thoughtSignature" {
				changed = true
				continue
			}
			next := e
			if k != "arguments" && k != "args" && k != "parameters" && k != "functionCall" {
				var ch bool
				next, ch = stripSignatures(e)
				changed = changed || ch
			}
			out.Set(k, next)
		}
		if !changed {
			return v, false
		}
		return out, true
	}
	return v, false
}
