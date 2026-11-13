package server

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
)

// UsageTap is UsageTap.
type UsageTap struct {
	parser sse.Parser
	dec    events.Decoder
	Usage  events.StreamUsage
	// Model is the model name on the upstream response (last non-empty).
	Model          string
	Error          *string
	ErrorType      *string
	FirstContentAt *float64
	FirstTextAt    *float64
	LastContentAt  *float64
	residual       bool
	now            func() float64
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
		t.take(t.dec.Push(ev))
	}
}

func (t *UsageTap) take(evs []events.NormEvent) {
	for _, e := range evs {
		switch e.Type {
		case "start", "finish", "usage":
			t.Usage = events.MergeUsage(t.Usage, e.Usage)
			if e.Type == "start" && e.Model != nil && *e.Model != "" {
				t.Model = *e.Model
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
				t.content()
			}
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
		t.take(t.dec.Push(ev))
	}
}

// End is end.
func (t *UsageTap) End() events.StreamUsage {
	t.FlushResidual()
	t.take(t.dec.End())
	return t.Usage
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
