package server

import (
	"net/http"
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

func TestUsageTapFingerprint(t *testing.T) {
	// 1) Chat SSE：system_fingerprint + service_tier + chatcmpl- ID
	chatTap := NewUsageTap("chat")
	chatTap.Push(sseBlocks(
		`{"id":"chatcmpl-123","model":"gpt-6.2-sol","system_fingerprint":"fp_abc999","service_tier":"priority","choices":[{"index":0,"delta":{"content":"ok"}}]}`,
	))
	chatTap.End()
	cfp := chatTap.Fingerprint()
	if cfp.ResponseModel != "gpt-6.2-sol" || cfp.ResponseID != "chatcmpl-123" ||
		cfp.SystemFingerprint != "fp_abc999" || cfp.ServiceTier != "priority" {
		t.Fatalf("unexpected chat fingerprint: %+v", cfp)
	}

	// 2) Responses SSE：resp_ + encrypted_content + service_tier
	respTap := NewUsageTap("responses")
	respTap.Push(sseBlocks(
		`{"type":"response.created","response":{"id":"resp_001","model":"gpt-6.2-sol","service_tier":"default"}}`,
		`{"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","encrypted_content":"enc_xyz"}}`,
		`{"type":"response.completed","response":{"id":"resp_001","model":"gpt-6.2-sol","status":"completed","output":[]}}`,
	))
	respTap.End()
	rfp := respTap.Fingerprint()
	if rfp.ResponseID != "resp_001" || !rfp.HasSealedReasoning || rfp.ServiceTier != "default" {
		t.Fatalf("unexpected responses fingerprint: %+v", rfp)
	}

	// 3) Messages SSE：msg_ + thinking + signature_delta
	msgTap := NewUsageTap("messages")
	msgTap.Push(sseBlocks(
		`{"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_123"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_stop"}`,
	))
	msgTap.End()
	mfp := msgTap.Fingerprint()
	if mfp.ResponseID != "msg_01" || !mfp.HasThinkSig || !mfp.HasReasoningText {
		t.Fatalf("unexpected messages fingerprint: %+v", mfp)
	}

	// 4) Gemini SSE：responseId + thoughtSignature
	gemTap := NewUsageTap("gemini")
	gemTap.Push(sseBlocks(
		`{"responseId":"resp_gem_1","modelVersion":"gemini-2.5-pro","candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"plan","thoughtSignature":"gsig"}]},"finishReason":"STOP"}]}`,
	))
	gemTap.End()
	gfp := gemTap.Fingerprint()
	if gfp.ResponseID != "resp_gem_1" || !gfp.HasThinkSig || !gfp.HasReasoningText {
		t.Fatalf("unexpected gemini fingerprint: %+v", gfp)
	}
}

func TestFingerprintOfJSONAndHeaders(t *testing.T) {
	v, err := u.ParseString(`{"id":"chatcmpl-j1","model":"deepseek-chat","system_fingerprint":"fp_ds_01","service_tier":"default","choices":[{"message":{"role":"assistant","reasoning_content":"think","content":"hi"},"finish_reason":"stop"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	fp := FingerprintOfJSON("chat", v)
	if fp.ResponseModel != "deepseek-chat" || fp.ResponseID != "chatcmpl-j1" ||
		fp.SystemFingerprint != "fp_ds_01" || !fp.HasReasoningText {
		t.Fatalf("unexpected json fingerprint: %+v", fp)
	}

	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer sk-secret-should-not-capture")
	hdr.Set("Set-Cookie", "session=secret")
	hdr.Set("X-Api-Key", "sk-secret")
	hdr.Set("X-Ds-Trace-Id", "ds-trace-777")
	hdr.Set("Openai-Version", "2020-10-01")
	hdr.Set("X-Openrouter-Model", "deepseek/deepseek-chat")
	got := ExtractFingerprintHeaders(hdr)
	if got["authorization"] != "" || got["set-cookie"] != "" || got["x-api-key"] != "" {
		t.Fatalf("secret header leaked into fingerprint: %+v", got)
	}
	if got["x-ds-trace-id"] != "ds-trace-777" || got["openai-version"] != "2020-10-01" ||
		got["x-openrouter-model"] != "deepseek/deepseek-chat" {
		t.Fatalf("missing whitelist headers: %+v", got)
	}
}
