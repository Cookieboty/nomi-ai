package stream

import (
	"math"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// jnum is json.ts num(): finite numbers only.
func jnum(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) || math.IsNaN(f) {
		return nil
	}
	return &f
}

func strOrNil(v any) *string {
	if s := u.Str(v); s != "" {
		return &s
	}
	return nil
}

func fid(seed, prefix, key string) string {
	if seed != "" {
		return prefix + "_" + seed + "_" + key
	}
	return prefix + "_" + key
}

func argsString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if v == nil {
		v = u.NewObj()
	}
	return u.Stringify(v)
}

func firstObj(v any) (*u.Obj, bool) {
	arr := u.AsArr(v)
	if len(arr) == 0 {
		return u.NewObj(), false
	}
	return arr[0], true
}

func errorEvents(e any, fallback string) []events.NormEvent {
	o := u.AsObj(e)
	msg := u.Str(o.Get("message"))
	if msg == "" {
		if s, ok := e.(string); ok {
			msg = s
		} else {
			msg = "upstream error"
		}
	}
	t := u.Str(o.Get("type"))
	if t == "" {
		t = u.Str(o.Get("code"))
	}
	if t == "" {
		t = u.Str(o.Get("status"))
	}
	if t == "" {
		t = fallback
	}
	return []events.NormEvent{{Type: events.Error, Message: msg, ErrorType: &t}}
}

func chatJson(j *u.Obj, seed string) []events.NormEvent {
	if u.Truthy(j.Get("error")) {
		return errorEvents(j.Get("error"), "api_error")
	}
	us := u.AsObj(j.Get("usage"))
	usage := &events.StreamUsage{InputTokens: jnum(us.Get("prompt_tokens")), OutputTokens: jnum(us.Get("completion_tokens")),
		CacheReadTokens: jnum(u.AsObj(us.Get("prompt_tokens_details")).Get("cached_tokens")),
		ReasoningTokens: jnum(u.AsObj(us.Get("completion_tokens_details")).Get("reasoning_tokens"))}
	out := []events.NormEvent{{Type: events.Start, ID: strOrNil(j.Get("id")), Model: strOrNil(j.Get("model")), Usage: usage}}
	c, _ := firstObj(j.Get("choices"))
	msg := u.AsObj(c.Get("message"))
	reasoning := u.Str(msg.Get("reasoning_content"))
	if reasoning == "" {
		reasoning = u.Str(msg.Get("reasoning"))
	}
	if reasoning != "" {
		out = append(out, events.NormEvent{Type: events.ThinkStart}, events.NormEvent{Type: events.Think, Text: reasoning})
	}
	if s := u.Str(msg.Get("content")); s != "" {
		out = append(out, events.NormEvent{Type: events.Text, Text: s})
	}
	calls := u.AsArr(msg.Get("tool_calls"))
	for i, tc := range calls {
		fn := u.AsObj(tc.Get("function"))
		key := u.FormatNumber(float64(i))
		id := u.Str(tc.Get("id"))
		if id == "" {
			id = fid(seed, "call", key)
		}
		out = append(out, events.NormEvent{Type: events.ToolStart, Key: key, ID: &id, Name: u.Str(fn.Get("name"))},
			events.NormEvent{Type: events.ToolArgs, Key: key, Delta: argsString(fn.Get("arguments"))},
			events.NormEvent{Type: events.ToolEnd, Key: key})
	}
	fr := c.Get("finish_reason")
	reason := "end_turn"
	if fr == "length" {
		reason = "max_tokens"
	} else if fr == "tool_calls" || len(calls) > 0 {
		reason = "tool_use"
	}
	return append(out, events.NormEvent{Type: events.Finish, Reason: reason, Usage: usage})
}

func responsesJson(j *u.Obj) []events.NormEvent {
	if u.Truthy(j.Get("error")) && j.Get("status") != "completed" {
		return errorEvents(j.Get("error"), "api_error")
	}
	us := u.AsObj(j.Get("usage"))
	usage := &events.StreamUsage{InputTokens: jnum(us.Get("input_tokens")), OutputTokens: jnum(us.Get("output_tokens")),
		CacheReadTokens: jnum(u.AsObj(us.Get("input_tokens_details")).Get("cached_tokens")),
		ReasoningTokens: jnum(u.AsObj(us.Get("output_tokens_details")).Get("reasoning_tokens"))}
	out := []events.NormEvent{{Type: events.Start, ID: strOrNil(j.Get("id")), Model: strOrNil(j.Get("model")), Usage: usage}}
	sawTool := false
	for i, item := range u.AsArr(j.Get("output")) {
		switch item.Get("type") {
		case "reasoning":
			out = append(out, events.NormEvent{Type: events.ThinkStart, ID: strOrNil(item.Get("id"))})
			var parts []string
			for _, s := range u.AsArr(item.Get("summary")) {
				if t := u.Str(s.Get("text")); t != "" {
					parts = append(parts, t)
				}
			}
			if sm := strings.Join(parts, "\n"); sm != "" {
				out = append(out, events.NormEvent{Type: events.Think, Text: sm})
			}
			if u.Str(item.Get("encrypted_content")) != "" {
				out = append(out, events.NormEvent{Type: events.Sealed, By: "responses", Raw: item})
			}
		case "message":
			var b strings.Builder
			for _, c := range u.AsArr(item.Get("content")) {
				switch c.Get("type") {
				case "output_text":
					b.WriteString(u.Str(c.Get("text")))
				case "refusal":
					b.WriteString(u.Str(c.Get("refusal")))
				}
			}
			if b.Len() > 0 {
				out = append(out, events.NormEvent{Type: events.Text, Text: b.String()})
			}
		case "function_call":
			sawTool = true
			key := u.Str(item.Get("id"))
			if key == "" {
				key = u.FormatNumber(float64(i))
			}
			id := u.Str(item.Get("call_id"))
			if id == "" {
				id = key
			}
			out = append(out, events.NormEvent{Type: events.ToolStart, Key: key, ID: &id, Name: u.Str(item.Get("name"))},
				events.NormEvent{Type: events.ToolArgs, Key: key, Delta: argsString(item.Get("arguments"))},
				events.NormEvent{Type: events.ToolEnd, Key: key})
		}
	}
	reason := "end_turn"
	if u.AsObj(j.Get("incomplete_details")).Get("reason") == "max_output_tokens" {
		reason = "max_tokens"
	} else if sawTool {
		reason = "tool_use"
	}
	return append(out, events.NormEvent{Type: events.Finish, Reason: reason, Usage: usage})
}

func geminiJson(j *u.Obj, seed string) []events.NormEvent {
	if u.Truthy(j.Get("error")) {
		return errorEvents(j.Get("error"), "api_error")
	}
	um := u.AsObj(j.Get("usageMetadata"))
	usage := &events.StreamUsage{InputTokens: jnum(um.Get("promptTokenCount")), OutputTokens: jnum(um.Get("candidatesTokenCount")),
		CacheReadTokens: jnum(um.Get("cachedContentTokenCount")), ReasoningTokens: jnum(um.Get("thoughtsTokenCount"))}
	out := []events.NormEvent{{Type: events.Start, ID: strOrNil(j.Get("responseId")), Model: strOrNil(j.Get("modelVersion")), Usage: usage}}
	c, ok := firstObj(j.Get("candidates"))
	if !ok {
		block := u.AsObj(j.Get("promptFeedback")).Get("blockReason")
		t := "invalid_request_error"
		return []events.NormEvent{{Type: events.Error, Message: "prompt blocked: " + jsStringOr(block, "no candidates"), ErrorType: &t}}
	}
	n := 0
	thinking := false
	for _, p := range u.AsArr(u.AsObj(c.Get("content")).Get("parts")) {
		sig := u.Str(p.Get("thoughtSignature"))
		if p.Get("thought") == true {
			if !thinking {
				out = append(out, events.NormEvent{Type: events.ThinkStart})
			}
			thinking = true
			if s := u.Str(p.Get("text")); s != "" {
				out = append(out, events.NormEvent{Type: events.Think, Text: s})
			}
			if sig != "" {
				out = append(out, events.NormEvent{Type: events.ThinkSig, Signature: sig})
			}
			continue
		}
		thinking = false
		if s := u.Str(p.Get("text")); s != "" {
			out = append(out, events.NormEvent{Type: events.Text, Text: s})
		}
		if sig != "" {
			out = append(out, events.NormEvent{Type: events.TextSig, Signature: sig})
		}
		if u.Truthy(p.Get("functionCall")) {
			fc := u.AsObj(p.Get("functionCall"))
			key := u.FormatNumber(float64(n))
			n++
			id := u.Str(fc.Get("id"))
			if id == "" {
				id = fid(seed, "call_gemini", key)
			}
			out = append(out, events.NormEvent{Type: events.ToolStart, Key: key, ID: &id, Name: u.Str(fc.Get("name"))},
				events.NormEvent{Type: events.ToolArgs, Key: key, Delta: argsString(fc.Get("args"))},
				events.NormEvent{Type: events.ToolEnd, Key: key})
		}
	}
	reason := "end_turn"
	if c.Get("finishReason") == "MAX_TOKENS" {
		reason = "max_tokens"
	} else if n > 0 {
		reason = "tool_use"
	}
	return append(out, events.NormEvent{Type: events.Finish, Reason: reason, Usage: usage})
}

func messagesJson(j *u.Obj) []events.NormEvent {
	if j.Get("type") == "error" || u.Truthy(j.Get("error")) {
		return errorEvents(j.Get("error"), "api_error")
	}
	us := u.AsObj(j.Get("usage"))
	usage := &events.StreamUsage{InputTokens: jnum(us.Get("input_tokens")), OutputTokens: jnum(us.Get("output_tokens")),
		CacheReadTokens: jnum(us.Get("cache_read_input_tokens")), CacheWriteTokens: jnum(us.Get("cache_creation_input_tokens"))}
	out := []events.NormEvent{{Type: events.Start, ID: strOrNil(j.Get("id")), Model: strOrNil(j.Get("model")), Usage: usage}}
	for i, b := range u.AsArr(j.Get("content")) {
		switch {
		case b.Get("type") == "thinking":
			out = append(out, events.NormEvent{Type: events.ThinkStart})
			if s := u.Str(b.Get("thinking")); s != "" {
				out = append(out, events.NormEvent{Type: events.Think, Text: s})
			}
			if s := u.Str(b.Get("signature")); s != "" {
				out = append(out, events.NormEvent{Type: events.ThinkSig, Signature: s})
			}
		case b.Get("type") == "redacted_thinking":
			out = append(out, events.NormEvent{Type: events.Sealed, By: "messages", Raw: b})
		case b.Get("type") == "text" && u.Str(b.Get("text")) != "":
			out = append(out, events.NormEvent{Type: events.Text, Text: u.Str(b.Get("text"))})
		case b.Get("type") == "tool_use":
			key := u.FormatNumber(float64(i))
			id := u.Str(b.Get("id"))
			out = append(out, events.NormEvent{Type: events.ToolStart, Key: key, ID: &id, Name: u.Str(b.Get("name"))},
				events.NormEvent{Type: events.ToolArgs, Key: key, Delta: argsString(b.Get("input"))},
				events.NormEvent{Type: events.ToolEnd, Key: key})
		}
	}
	reason := "end_turn"
	switch sr := j.Get("stop_reason"); sr {
	case "max_tokens", "tool_use", "stop_sequence", "refusal":
		reason = sr.(string)
	}
	return append(out, events.NormEvent{Type: events.Finish, Reason: reason, Usage: usage})
}

// JsonToEvents is jsonToEvents.
func JsonToEvents(from string, body any, seed string) []events.NormEvent {
	j := u.AsObj(body)
	switch from {
	case "chat":
		return chatJson(j, seed)
	case "responses":
		return responsesJson(j)
	case "gemini":
		return geminiJson(j, seed)
	}
	return messagesJson(j)
}
