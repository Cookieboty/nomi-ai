package stream

import (
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// CustomToolInput is customToolInput: {"input":"..."} → raw string.
func CustomToolInput(args string) string {
	v, err := u.ParseString(args)
	if err != nil {
		return args
	}
	if o, ok := v.(*u.Obj); ok {
		if s, ok := o.Get("input").(string); ok {
			return s
		}
	}
	if s, ok := v.(string); ok {
		return s
	}
	return args
}

// AggregateResult is AggregateResult.
type AggregateResult struct {
	OK     bool
	Status float64
	Body   any
}

type aggBlock struct {
	tool           bool
	text           string
	id, name, args string
}

// EventsToJson is eventsToJson.
func EventsToJson(to string, evs []events.NormEvent, model string, customTools map[string]bool) AggregateResult {
	var id *string
	usage := events.StreamUsage{}
	reason := "end_turn"
	var blocks []*aggBlock
	tools := map[string]*aggBlock{}
	for _, ev := range evs {
		switch ev.Type {
		case events.Start:
			if ev.ID != nil {
				id = ev.ID
			}
			if ev.Model != nil && *ev.Model != "" {
				model = *ev.Model
			}
			if ev.Usage != nil {
				usage = spreadUsage(usage, ev.Usage)
			}
		case events.Text:
			if n := len(blocks); n > 0 && !blocks[n-1].tool {
				blocks[n-1].text += ev.Text
			} else {
				blocks = append(blocks, &aggBlock{text: ev.Text})
			}
		case events.ToolStart:
			b := &aggBlock{tool: true, id: strOr(ev.ID, ""), name: ev.Name}
			tools[ev.Key] = b
			blocks = append(blocks, b)
		case events.ToolArgs:
			if b := tools[ev.Key]; b != nil {
				b.args += ev.Delta
			}
		case events.Finish:
			reason = ev.Reason
			if ev.Usage != nil {
				usage = spreadUsage(usage, ev.Usage)
			}
		case events.Error:
			return errorBody(to, ev.Message, ev.ErrorType)
		}
	}
	in, out := orZero(usage.InputTokens), orZero(usage.OutputTokens)
	var tb strings.Builder
	for _, b := range blocks {
		if !b.tool {
			tb.WriteString(b.text)
		}
	}
	text := tb.String()
	idOr := func(p string) string {
		if id != nil && *id != "" {
			return *id
		}
		return rid(p)
	}
	orEmpty := func(s string) string {
		if s == "" {
			return "{}"
		}
		return s
	}

	switch to {
	case "messages":
		content := []any{}
		for _, b := range blocks {
			if !b.tool {
				content = append(content, u.NewObj("type", "text", "text", b.text))
			} else {
				content = append(content, u.NewObj("type", "tool_use", "id", response.EscapeCallID(b.id), "name", b.name, "input", parseArgsObject(b.args)))
			}
		}
		return AggregateResult{true, 200, u.NewObj("id", idOr("msg"), "type", "message", "role", "assistant", "model", model,
			"content", content, "stop_reason", reason, "stop_sequence", nil,
			"usage", u.NewObj("input_tokens", in, "output_tokens", out))}
	case "chat":
		var calls []any
		for _, b := range blocks {
			if b.tool {
				calls = append(calls, u.NewObj("id", b.id, "type", "function", "function", u.NewObj("name", b.name, "arguments", orEmpty(b.args))))
			}
		}
		var c any
		if text != "" {
			c = text
		}
		msg := u.NewObj("role", "assistant", "content", c)
		if len(calls) > 0 {
			msg.Set("tool_calls", calls)
		}
		bid := idOr("chatcmpl")
		return AggregateResult{true, 200, u.NewObj("id", bid, "object", "chat.completion", "created", nowSec(), "model", model,
			"choices", []any{u.NewObj("index", 0.0, "message", msg, "finish_reason", chatFinishReason(reason))},
			"usage", u.NewObj("prompt_tokens", in, "completion_tokens", out, "total_tokens", in+out))}
	case "gemini":
		parts := []any{}
		for _, b := range blocks {
			if !b.tool {
				parts = append(parts, u.NewObj("text", b.text))
			} else {
				parts = append(parts, u.NewObj("functionCall", u.NewObj("id", b.id, "name", b.name, "args", parseArgsObject(b.args))))
			}
		}
		fr := "STOP"
		if reason == "max_tokens" {
			fr = "MAX_TOKENS"
		}
		return AggregateResult{true, 200, u.NewObj(
			"candidates", []any{u.NewObj("content", u.NewObj("role", "model", "parts", parts), "finishReason", fr, "index", 0.0)},
			"usageMetadata", u.NewObj("promptTokenCount", in, "candidatesTokenCount", out, "totalTokenCount", in+out),
			"modelVersion", model, "responseId", idOr("gemini"))}
	}
	output := []any{}
	for _, b := range blocks {
		switch {
		case !b.tool:
			output = append(output, u.NewObj("type", "message", "id", rid("msg"), "status", "completed", "role", "assistant",
				"content", []any{u.NewObj("type", "output_text", "text", b.text, "annotations", []any{})}))
		case customTools[b.name]:
			iid := rid("ctc")
			if b.id != "" {
				iid = "ctc_" + response.EscapeCallID(b.id)
			}
			output = append(output, u.NewObj("type", "custom_tool_call", "id", iid, "call_id", b.id, "name", b.name,
				"input", CustomToolInput(b.args), "status", "completed"))
		default:
			iid := rid("fc")
			if b.id != "" {
				iid = "fc_" + response.EscapeCallID(b.id)
			}
			output = append(output, u.NewObj("type", "function_call", "id", iid, "call_id", b.id, "name", b.name,
				"arguments", orEmpty(b.args), "status", "completed"))
		}
	}
	incomplete := reason == "max_tokens"
	rid0 := rid("resp")
	if id != nil && strings.HasPrefix(*id, "resp_") {
		rid0 = *id
	}
	status := "completed"
	if incomplete {
		status = "incomplete"
	}
	body := u.NewObj("id", rid0, "object", "response", "created_at", nowSec(), "status", status)
	if incomplete {
		body.Set("incomplete_details", u.NewObj("reason", "max_output_tokens"))
	}
	body.Set("model", model).Set("output", output).Set("output_text", text).
		Set("usage", u.NewObj("input_tokens", in, "output_tokens", out, "total_tokens", in+out))
	return AggregateResult{true, 200, body}
}

func errorBody(to, message string, errorType *string) AggregateResult {
	et := strOr(errorType, "")
	status := 502.0
	switch et {
	case "rate_limit_error":
		status = 429
	case "overloaded_error":
		status = 529
	}
	t := et
	if t == "" {
		t = "api_error"
	}
	switch to {
	case "messages":
		return AggregateResult{false, status, u.NewObj("type", "error", "error", u.NewObj("type", t, "message", message))}
	case "gemini":
		return AggregateResult{false, status, u.NewObj("error", u.NewObj("code", status, "message", message, "status", GeminiErrorStatus(errorType).Status))}
	}
	return AggregateResult{false, status, u.NewObj("error", u.NewObj("message", message, "type", t, "code", t))}
}
