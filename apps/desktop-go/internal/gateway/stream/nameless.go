package stream

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"

// NamelessToolGuard is NamelessToolGuard (stream/namelessTools.ts): drops tool
// calls that never got a tool name, for every upstream wire.
type NamelessToolGuard struct {
	dropped map[string]bool
	kept    bool
}

// Push returns false when the event is dropped.
func (g *NamelessToolGuard) Push(n events.NormEvent) (events.NormEvent, bool) {
	switch n.Type {
	case events.ToolStart:
		if n.Name != "" {
			g.kept = true
			return n, true
		}
		if g.dropped == nil {
			g.dropped = map[string]bool{}
		}
		g.dropped[n.Key] = true
		return n, false
	case events.ToolArgs, events.ToolEnd:
		return n, !g.dropped[n.Key]
	case events.Finish:
		if len(g.dropped) > 0 && !g.kept && n.Reason == "tool_use" {
			n.Reason = "end_turn"
		}
	}
	return n, true
}

// DropNamelessTools is dropNamelessTools.
func DropNamelessTools(evs []events.NormEvent) []events.NormEvent {
	var g NamelessToolGuard
	out := make([]events.NormEvent, 0, len(evs))
	for _, n := range evs {
		if r, ok := g.Push(n); ok {
			out = append(out, r)
		}
	}
	return out
}
