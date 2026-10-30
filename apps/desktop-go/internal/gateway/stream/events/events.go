// Package events mirrors apps/desktop-electron/internal/gateway/src/stream/events.ts (NormEvent and
// the decoder / encoder contracts). Leaf package, see deviation D15.
package events

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"

// Event types (NormEvent['type']).
const (
	Start      = "start"
	Text       = "text"
	ThinkStart = "think_start"
	Think      = "think"
	ThinkSig   = "think_sig"
	Sealed     = "sealed"
	TextSig    = "text_sig"
	ToolStart  = "tool_start"
	ToolArgs   = "tool_args"
	ToolEnd    = "tool_end"
	Usage      = "usage"
	Finish     = "finish"
	Error      = "error"
	Alive      = "alive"
)

// StreamUsage: nil means the field is absent (TS undefined).
type StreamUsage struct {
	InputTokens      *float64
	OutputTokens     *float64
	CacheReadTokens  *float64
	CacheWriteTokens *float64
	ReasoningTokens  *float64
}

// Clone is `{ ...u }`.
func (u *StreamUsage) Clone() *StreamUsage {
	if u == nil {
		return nil
	}
	c := *u
	return &c
}

// MergeUsage is mergeUsage: defined fields of b override a.
func MergeUsage(a StreamUsage, b *StreamUsage) StreamUsage {
	o := a
	if b == nil {
		return o
	}
	if b.InputTokens != nil {
		o.InputTokens = b.InputTokens
	}
	if b.OutputTokens != nil {
		o.OutputTokens = b.OutputTokens
	}
	if b.CacheReadTokens != nil {
		o.CacheReadTokens = b.CacheReadTokens
	}
	if b.CacheWriteTokens != nil {
		o.CacheWriteTokens = b.CacheWriteTokens
	}
	if b.ReasoningTokens != nil {
		o.ReasoningTokens = b.ReasoningTokens
	}
	return o
}

// NormEvent is the tagged union flattened into one struct; only the fields of
// Type are meaningful.
type NormEvent struct {
	Type string
	// start / think_start
	ID    *string
	Model *string
	Usage *StreamUsage // start, usage, finish
	// text / think
	Text string
	// think_sig / text_sig
	Signature string
	// sealed
	By  string
	Raw any
	// tool_*
	Key   string
	Name  string
	Delta string
	// finish
	Reason string
	// error
	Message      string
	ErrorType    *string
	Status       *float64
	RetryAfterMs *float64
}

// Decoder is StreamDecoder.
type Decoder interface {
	Push(ev sse.Event) []NormEvent
	End() []NormEvent
	Terminated() bool
}

// Encoder is StreamEncoder.
type Encoder interface {
	Encode(ev NormEvent) string
	End() string
}
