package server

import (
	"net/http"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/modelid"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// StreamFingerprint holds non-sensitive model identity signals observed on an upstream response.
type StreamFingerprint struct {
	ResponseModel      string            `json:"responseModel,omitempty"`
	ResponseID         string            `json:"responseId,omitempty"`
	SystemFingerprint  string            `json:"systemFingerprint,omitempty"`
	ServiceTier        string            `json:"serviceTier,omitempty"`
	HasThinkSig        bool              `json:"hasThinkSig,omitempty"`
	HasSealedReasoning bool              `json:"hasSealedReasoning,omitempty"`
	HasReasoningText   bool              `json:"hasReasoningText,omitempty"`
	Headers            map[string]string `json:"headers,omitempty"`
}

// IsEmpty reports whether no fingerprint signal was observed.
func (f StreamFingerprint) IsEmpty() bool {
	return f.ResponseModel == "" &&
		f.ResponseID == "" &&
		f.SystemFingerprint == "" &&
		f.ServiceTier == "" &&
		!f.HasThinkSig &&
		!f.HasSealedReasoning &&
		!f.HasReasoningText &&
		len(f.Headers) == 0
}

// ToObj serializes the fingerprint into an ordered object for gateway usage events.
func (f StreamFingerprint) ToObj() *u.Obj {
	o := u.NewObj()
	if f.ResponseModel != "" {
		o.Set("responseModel", f.ResponseModel)
	}
	if f.ResponseID != "" {
		o.Set("responseId", f.ResponseID)
	}
	if f.SystemFingerprint != "" {
		o.Set("systemFingerprint", f.SystemFingerprint)
	}
	if f.ServiceTier != "" {
		o.Set("serviceTier", f.ServiceTier)
	}
	if f.HasThinkSig {
		o.Set("hasThinkSig", true)
	}
	if f.HasSealedReasoning {
		o.Set("hasSealedReasoning", true)
	}
	if f.HasReasoningText {
		o.Set("hasReasoningText", true)
	}
	if len(f.Headers) > 0 {
		h := u.NewObj()
		for _, k := range FingerprintHeaderNames {
			if v, ok := f.Headers[k]; ok && v != "" {
				h.Set(k, v)
			}
		}
		if h.Len() > 0 {
			o.Set("headers", h)
		}
	}
	return o
}

// FingerprintHeaderNames lists safe, non-secret response headers that help verify upstream identity.
var FingerprintHeaderNames = []string{
	"openai-version",
	"openai-processing-ms",
	"openai-model",
	"x-openai-proxy-wasm",
	"anthropic-version",
	"request-id",
	"x-ds-trace-id",
	"x-deepseek-version",
	"x-goog-api-version",
	"x-openrouter-model",
	"x-served-by",
	"x-model",
	"x-upstream-model",
	"server",
}

// ExtractFingerprintHeaders captures non-sensitive whitelisted upstream headers.
func ExtractFingerprintHeaders(h http.Header) map[string]string {
	if h == nil {
		return nil
	}
	var out map[string]string
	for _, k := range FingerprintHeaderNames {
		v := strings.TrimSpace(h.Get(k))
		if v == "" {
			continue
		}
		v = modelid.Clip(RedactText(v, nil), 120)
		if v == "" {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = v
	}
	return out
}

// UsageTap is UsageTap.
type UsageTap struct {
	parser sse.Parser
	dec    events.Decoder
	Usage  events.StreamUsage
	// Model is the model name on the upstream response (last non-empty).
	Model              string
	ResponseID         string
	SystemFingerprint  string
	ServiceTier        string
	HasThinkSig        bool
	HasSealedReasoning bool
	HasReasoningText   bool
	Error              *string
	ErrorType          *string
	FirstContentAt     *float64
	FirstTextAt        *float64
	LastContentAt      *float64
	residual           bool
	now                func() float64
}

// NewUsageTap is new UsageTap(wire).
func NewUsageTap(wire string) *UsageTap {
	return &UsageTap{dec: stream.PureDecoder(wire), now: NowMs}
}

// Terminated is the terminated getter.
func (t *UsageTap) Terminated() bool { return t.dec.Terminated() }

// FlushResidual is flushResidual.
func (t *UsageTap) FlushResidual() {
	if t.residual {
		return
	}
	t.residual = true
	for _, ev := range t.parser.End() {
		t.inspectSSE(ev)
		t.take(t.dec.Push(ev))
	}
}

func (t *UsageTap) inspectSSE(ev sse.Event) {
	if ev.Data == "" || (!strings.Contains(ev.Data, "system_fingerprint") && !strings.Contains(ev.Data, "service_tier")) {
		return
	}
	v, err := u.ParseString(ev.Data)
	if err != nil {
		return
	}
	o := u.AsObj(v)
	if o == nil {
		return
	}
	if fp := u.Str(o.Get("system_fingerprint")); fp != "" {
		t.SystemFingerprint = modelid.Clip(fp, 120)
	}
	if st := u.Str(o.Get("service_tier")); st != "" {
		t.ServiceTier = modelid.Clip(st, 40)
	}
	if resp := u.AsObj(o.Get("response")); resp != nil {
		if st := u.Str(resp.Get("service_tier")); st != "" {
			t.ServiceTier = modelid.Clip(st, 40)
		}
	}
}

func (t *UsageTap) take(evs []events.NormEvent) {
	for _, e := range evs {
		switch e.Type {
		case "start", "finish", "usage":
			t.Usage = events.MergeUsage(t.Usage, e.Usage)
			if e.Type == "start" {
				if e.ID != nil && *e.ID != "" && t.ResponseID == "" {
					t.ResponseID = modelid.Clip(*e.ID, 120)
				}
				if e.Model != nil && *e.Model != "" {
					t.Model = modelid.Clip(*e.Model, 200)
				}
			}
		case "error":
			if t.Error == nil {
				m := e.Message
				t.Error = &m
				t.ErrorType = e.ErrorType
			}
		case "text":
			if e.Text == "" {
				break
			}
			t.content()
			if t.FirstTextAt == nil {
				t.FirstTextAt = t.LastContentAt
			}
		case "think":
			if e.Text != "" {
				t.HasReasoningText = true
				t.content()
			}
		case "think_sig":
			t.HasThinkSig = true
		case "sealed":
			t.HasSealedReasoning = true
		case "tool_start", "tool_args":
			t.content()
		}
	}
}

func (t *UsageTap) content() {
	n := t.now()
	if t.FirstContentAt == nil {
		t.FirstContentAt = &n
	}
	t.LastContentAt = &n
}

// Push is push.
func (t *UsageTap) Push(text string) {
	for _, ev := range t.parser.Push(text) {
		t.inspectSSE(ev)
		t.take(t.dec.Push(ev))
	}
}

// End is end.
func (t *UsageTap) End() events.StreamUsage {
	t.FlushResidual()
	t.take(t.dec.End())
	return t.Usage
}

// Fingerprint returns the model identity signals collected from the SSE stream.
func (t *UsageTap) Fingerprint() StreamFingerprint {
	return StreamFingerprint{
		ResponseModel:      t.Model,
		ResponseID:         t.ResponseID,
		SystemFingerprint:  t.SystemFingerprint,
		ServiceTier:        t.ServiceTier,
		HasThinkSig:        t.HasThinkSig,
		HasSealedReasoning: t.HasSealedReasoning,
		HasReasoningText:   t.HasReasoningText,
	}
}

// UsageOfJSON is usageOfJson.
func UsageOfJSON(wire string, body any) events.StreamUsage {
	var us events.StreamUsage
	for _, e := range stream.JsonToEvents(wire, body, "") {
		if e.Type == "start" || e.Type == "finish" {
			us = events.MergeUsage(us, e.Usage)
		}
	}
	return us
}

// ResponseModelOf is the model field on a non-streaming upstream body
// (chat/responses/messages `model`, Gemini `modelVersion`). Empty if absent.
func ResponseModelOf(wire string, body any) string {
	model := ""
	for _, e := range stream.JsonToEvents(wire, body, "") {
		if e.Type == "start" && e.Model != nil && *e.Model != "" {
			model = *e.Model
		}
	}
	return model
}

// FingerprintOfJSON extracts non-sensitive model identity signals from a non-streaming response body.
func FingerprintOfJSON(wire string, body any) StreamFingerprint {
	var fp StreamFingerprint
	for _, e := range stream.JsonToEvents(wire, body, "") {
		switch e.Type {
		case "start":
			if e.ID != nil && *e.ID != "" && fp.ResponseID == "" {
				fp.ResponseID = modelid.Clip(*e.ID, 120)
			}
			if e.Model != nil && *e.Model != "" {
				fp.ResponseModel = modelid.Clip(*e.Model, 200)
			}
		case "think":
			if e.Text != "" {
				fp.HasReasoningText = true
			}
		case "think_sig":
			fp.HasThinkSig = true
		case "sealed":
			fp.HasSealedReasoning = true
		}
	}
	if o := u.AsObj(body); o != nil {
		if s := u.Str(o.Get("system_fingerprint")); s != "" {
			fp.SystemFingerprint = modelid.Clip(s, 120)
		}
		if st := u.Str(o.Get("service_tier")); st != "" {
			fp.ServiceTier = modelid.Clip(st, 40)
		}
	}
	return fp
}
