package response

import (
	"strconv"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
)

// EventFixer is EventFixer.
type EventFixer struct {
	rules    *Rules
	injected int
	Stopped  bool
}

// NewEventFixer is new EventFixer(o).
func NewEventFixer(o *FixOptions) *EventFixer { return &EventFixer{rules: NewRules(o)} }

// Tripped is `tripped`.
func (f *EventFixer) Tripped() bool { return f.rules.Tripped }

// Push is push.
func (f *EventFixer) Push(ev events.NormEvent) []events.NormEvent {
	if f.Stopped {
		return nil
	}
	switch ev.Type {
	case events.Think:
		if f.rules.Reasoning(ev.Text) {
			return f.trip()
		}
		return []events.NormEvent{ev}
	case events.Text:
		t, ok := f.rules.Text(ev.Text)
		if !ok {
			return f.trip()
		}
		if t == "" {
			return nil
		}
		if t == ev.Text {
			return []events.NormEvent{ev}
		}
		return []events.NormEvent{{Type: events.Text, Text: t}}
	case events.ToolStart:
		out := f.flush()
		if orig := f.rules.ToolName(ev.Name); orig != "" {
			ev.Name = orig
		}
		return append(out, ev)
	case events.Finish:
		out := f.flush()
		if f.injected > 0 && ev.Reason == "end_turn" {
			ev.Reason = "tool_use"
		}
		f.Stopped = true
		return append(out, ev)
	case events.Error:
		var out []events.NormEvent
		if raw := f.rules.ReleaseRaw(); raw != "" {
			out = append(out, events.NormEvent{Type: events.Text, Text: raw})
		}
		f.Stopped = true
		return append(out, ev)
	}
	return []events.NormEvent{ev}
}

func (f *EventFixer) trip() []events.NormEvent {
	f.Stopped = true
	t := "api_error"
	return []events.NormEvent{{Type: events.Error, Message: RepetitionMessage, ErrorType: &t}}
}

func (f *EventFixer) flush() []events.NormEvent {
	text, calls := f.rules.Flush()
	var out []events.NormEvent
	if text != "" {
		out = append(out, events.NormEvent{Type: events.Text, Text: text})
	}
	for _, c := range calls {
		key := "text_call_" + strconv.Itoa(f.injected)
		f.injected++
		id := c.ID
		out = append(out, events.NormEvent{Type: events.ToolStart, Key: key, ID: &id, Name: c.Name},
			events.NormEvent{Type: events.ToolArgs, Key: key, Delta: c.Args},
			events.NormEvent{Type: events.ToolEnd, Key: key})
	}
	return out
}

// FixEvents is fixEvents.
func FixEvents(evs []events.NormEvent, o *FixOptions) []events.NormEvent {
	f := NewEventFixer(o)
	var out []events.NormEvent
	for _, e := range evs {
		out = append(out, f.Push(e)...)
	}
	return out
}
