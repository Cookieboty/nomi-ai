package stream

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
)

// EventFixer is the response-fixer hook (models/rules/response/fixer.ts);
// nil means no fixes, like Node's `fixer = null`.
type EventFixer interface {
	Push(ev events.NormEvent) []events.NormEvent
	Tripped() bool
}

// ConvertOptions is ConvertOptions. Seed is opts.fixes?.callIds?.seed.
type ConvertOptions struct {
	Model       string
	CustomTools map[string]bool
	Seed        string
	Fixer       EventFixer
	// FixEvents is fixEvents(evs, {...fixes, repetition:false}) for JSON paths.
	FixEvents func([]events.NormEvent) []events.NormEvent
}

func makeEncoder(to, model string, customTools map[string]bool) events.Encoder {
	switch to {
	case "messages":
		return NewMessagesEncoder(model)
	case "responses":
		return NewResponsesEncoder(model, customTools)
	case "chat":
		return NewChatCompletionsEncoder(model)
	}
	return NewGeminiEncoder(model)
}

// StreamConverter is StreamConverter.
type StreamConverter struct {
	parser *sse.Parser
	dec    events.Decoder
	enc    events.Encoder
	fixer  EventFixer
	guard  NamelessToolGuard
}

// CreateStreamConverter is createStreamConverter.
func CreateStreamConverter(from, to string, opts ConvertOptions) *StreamConverter {
	return &StreamConverter{parser: &sse.Parser{}, dec: CreateDecoder(from, opts.Seed),
		enc: makeEncoder(to, opts.Model, opts.CustomTools), fixer: opts.Fixer}
}

func (c *StreamConverter) emit(ev events.NormEvent) string {
	n, ok := c.guard.Push(ev)
	if !ok {
		return ""
	}
	if c.fixer == nil {
		return c.enc.Encode(n)
	}
	s := ""
	for _, f := range c.fixer.Push(n) {
		s += c.enc.Encode(f)
	}
	return s
}

// Push converts one upstream chunk.
func (c *StreamConverter) Push(chunk string) string {
	s := ""
	for _, e := range c.parser.Push(chunk) {
		for _, n := range c.dec.Push(e) {
			s += c.emit(n)
		}
		if c.fixer != nil && c.fixer.Tripped() {
			break
		}
	}
	return s
}

// End handles normal upstream end.
func (c *StreamConverter) End() string {
	s := ""
	for _, e := range c.parser.End() {
		for _, n := range c.dec.Push(e) {
			s += c.emit(n)
		}
	}
	for _, n := range c.dec.End() {
		s += c.emit(n)
	}
	return s + c.enc.End()
}

// Fail handles mid-stream upstream failure.
func (c *StreamConverter) Fail(message string) string {
	t := "api_error"
	return c.enc.Encode(events.NormEvent{Type: events.Error, Message: message, ErrorType: &t}) + c.enc.End()
}

// Stopped reports fixer.tripped.
func (c *StreamConverter) Stopped() bool { return c.fixer != nil && c.fixer.Tripped() }

func jsonEvents(from string, body any, opts ConvertOptions) []events.NormEvent {
	evs := DropNamelessTools(JsonToEvents(from, body, opts.Seed))
	if opts.FixEvents != nil {
		return opts.FixEvents(evs)
	}
	return evs
}

// JsonToSse is jsonToSse.
func JsonToSse(from, to string, body any, opts ConvertOptions) string {
	enc := makeEncoder(to, opts.Model, opts.CustomTools)
	s := ""
	for _, n := range jsonEvents(from, body, opts) {
		s += enc.Encode(n)
	}
	return s + enc.End()
}

// JsonToJson is jsonToJson.
func JsonToJson(from, to string, body any, opts ConvertOptions) AggregateResult {
	return EventsToJson(to, jsonEvents(from, body, opts), opts.Model, opts.CustomTools)
}
