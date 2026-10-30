package stream

import (
	resp "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/response"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/sse"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Passthrough is Passthrough.
type Passthrough interface {
	Push(chunk string) string
	End() string
	Stopped() bool
}

type repetitionPassthrough struct {
	wire    string
	split   sse.Splitter
	parser  sse.Parser
	dec     events.Decoder
	rules   *resp.Rules
	stopped bool
}

func newRepetitionPassthrough(wire string, notes *[]string) *repetitionPassthrough {
	return &repetitionPassthrough{wire: wire, dec: CreateDecoder(wire, ""), rules: resp.NewRules(&resp.FixOptions{Repetition: true, Notes: notes})}
}

func (r *repetitionPassthrough) Stopped() bool { return r.stopped }

func (r *repetitionPassthrough) Push(chunk string) string {
	if r.stopped {
		return ""
	}
	out := ""
	for _, b := range r.split.Push(chunk) {
		block := b.Body + b.Sep
		if r.watch(block) {
			r.split.Take()
			return out + r.fail()
		}
		out += block
	}
	return out
}

func (r *repetitionPassthrough) End() string {
	if r.stopped {
		return ""
	}
	return r.split.Take()
}

func (r *repetitionPassthrough) watch(block string) bool {
	for _, ev := range r.parser.Push(block) {
		for _, n := range r.dec.Push(ev) {
			if n.Type == events.Think && r.rules.Reasoning(n.Text) {
				return true
			}
			if n.Type == events.Text {
				if _, ok := r.rules.Text(n.Text); !ok {
					return true
				}
			}
		}
	}
	return false
}

func (r *repetitionPassthrough) fail() string {
	r.stopped = true
	return CreateStreamConverter(r.wire, r.wire, ConvertOptions{}).Fail(resp.RepetitionMessage)
}

// CreatePassthrough is createPassthrough (nil = write raw bytes).
func CreatePassthrough(wire string, o *resp.FixOptions) Passthrough {
	if wire == "chat" {
		return NewChatStreamPatcher(o)
	}
	if o != nil && o.Repetition {
		return newRepetitionPassthrough(wire, o.Notes)
	}
	return nil
}

// PassthroughFail is passthroughFail.
func PassthroughFail(wire, message string) string {
	if wire != "responses" {
		return CreateStreamConverter(wire, wire, ConvertOptions{}).Fail(message)
	}
	e := u.NewObj()
	e.Set("code", "api_error")
	e.Set("message", message)
	r := u.NewObj()
	r.Set("object", "response")
	r.Set("status", "failed")
	r.Set("output", []any{})
	r.Set("error", e)
	o := u.NewObj()
	o.Set("type", "response.failed")
	o.Set("response", r)
	return sse.Format("response.failed", o)
}

// TerminalWatch is canonical/terminal.ts TerminalWatch (lives in stream to avoid an import cycle; D18).
type TerminalWatch struct {
	parser sse.Parser
	dec    events.Decoder
}

// NewTerminalWatch is new TerminalWatch(wire).
func NewTerminalWatch(wire string) *TerminalWatch {
	return &TerminalWatch{dec: CreateDecoder(wire, "")}
}

// Push is push.
func (t *TerminalWatch) Push(chunk string) {
	if t.dec.Terminated() {
		return
	}
	for _, ev := range t.parser.Push(chunk) {
		t.dec.Push(ev)
	}
}

// Terminated is the `terminated` getter.
func (t *TerminalWatch) Terminated() bool {
	if !t.dec.Terminated() {
		for _, ev := range t.parser.End() {
			t.dec.Push(ev)
		}
	}
	return t.dec.Terminated()
}

// WithFixes fills ConvertOptions from opts.fixes (ConvertOptions.fixes in Node):
// the call-id seed, a stream EventFixer, and the JSON-path fixEvents (repetition off).
func WithFixes(base ConvertOptions, o *resp.FixOptions) ConvertOptions {
	if o == nil {
		return base
	}
	if o.CallIds != nil {
		base.Seed = o.CallIds.Seed
	}
	if resp.FixesEnabled(o) {
		base.Fixer = resp.NewEventFixer(o)
		jo := *o
		jo.Repetition = false
		base.FixEvents = func(evs []events.NormEvent) []events.NormEvent { return resp.FixEvents(evs, &jo) }
	}
	return base
}
