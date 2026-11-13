package server

import (
	"strings"
	"testing"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func sseBlocks(blocks ...string) string {
	var b strings.Builder
	for _, block := range blocks {
		b.WriteString("data: ")
		b.WriteString(block)
		b.WriteString("\n\n")
	}
	return b.String()
}

func TestUsageTapResponseModel(t *testing.T) {
	cases := []struct {
		wire, body, want string
	}{
		{"messages", sseBlocks(`{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-actual","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`), "claude-actual"},
		{"chat", sseBlocks(`{"id":"c","model":"gpt-actual","choices":[{"index":0,"delta":{"content":"hi"}}]}`), "gpt-actual"},
		{"responses", sseBlocks(`{"type":"response.created","response":{"id":"r","model":"gpt-resp"}}`), "gpt-resp"},
		{"gemini", sseBlocks(`{"responseId":"g","modelVersion":"gemini-actual","candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}`), "gemini-actual"},
		// model arrives on a later chunk
		{"chat", sseBlocks(
			`{"id":"c","choices":[{"index":0,"delta":{"role":"assistant"}}]}`,
			`{"id":"c","model":"gpt-late","choices":[{"index":0,"delta":{"content":"a"}}]}`,
		), "gpt-late"},
		// completed carries the model when created did not
		{"responses", sseBlocks(
			`{"type":"response.created","response":{"id":"r"}}`,
			`{"type":"response.completed","response":{"id":"r","model":"gpt-done","status":"completed","output":[]}}`,
		), "gpt-done"},
	}
	for _, c := range cases {
		tap := NewUsageTap(c.wire)
		tap.Push(c.body)
		tap.End()
		if tap.Model != c.want {
			t.Errorf("%s stream model = %q, want %q", c.wire, tap.Model, c.want)
		}
	}
}

func TestResponseModelOfJSON(t *testing.T) {
	parse := func(s string) any {
		v, err := u.ParseString(s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct{ wire, body, want string }{
		{"chat", `{"id":"c","model":"gpt-json","choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}`, "gpt-json"},
		{"responses", `{"id":"r","model":"gpt-resp","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}]}`, "gpt-resp"},
		{"messages", `{"id":"m","type":"message","role":"assistant","model":"claude-json","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`, "claude-json"},
		{"gemini", `{"responseId":"g","modelVersion":"gemini-json","candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}`, "gemini-json"},
		{"chat", `{"id":"c","choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}`, ""},
	}
	for _, c := range cases {
		if got := ResponseModelOf(c.wire, parse(c.body)); got != c.want {
			t.Errorf("%s json model = %q, want %q", c.wire, got, c.want)
		}
	}
}
