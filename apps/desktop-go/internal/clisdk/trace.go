package clisdk

import "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

// Trace limits.
const (
	MaxTraceEvents        = 300
	MaxTraceBytes         = 400_000
	MaxTabFileBytes       = 6_000_000
	KeepFullTraceMessages = 20
)

// IsTraceEvent reports whether ev belongs in a turn's trace.
func IsTraceEvent(ev Ev) bool {
	t := ev.Get("type")
	return t == "tool" || t == "thinking" || t == "interject" || t == "agent-text" || t == "agent-input"
}

// StampEvent：tool / thinking / interject / agent-text 打主进程时间戳。
func StampEvent(ev Ev, now float64) Ev {
	if IsTraceEvent(ev) && !ev.Has("at") {
		ev.Set("at", now)
	}
	return ev
}

// BuildTrace builds a turn's trace from its events.
func BuildTrace(events []Ev) []Ev {
	out := []Ev{}
	for _, ev := range events {
		if !IsTraceEvent(ev) {
			continue
		}
		if len(out) > 0 {
			prev := out[len(out)-1]
			// 同一个子代理连续说的话合成一段
			if ev.Get("type") == "agent-text" && prev.Get("type") == "agent-text" && jsEq(prev.Get("parentId"), ev.Get("parentId")) {
				c := prev.Clone()
				c.Set("text", Slice0(util.JSString(prev.Get("text"))+"\n\n"+util.JSString(ev.Get("text")), 8000))
				out[len(out)-1] = c
				continue
			}
			if ev.Get("type") == "thinking" && prev.Get("type") == "thinking" && jsEq(prev.Get("textAt"), ev.Get("textAt")) {
				c := prev.Clone()
				c.Set("text", Slice0(util.JSString(prev.Get("text"))+util.JSString(ev.Get("text")), 8000))
				out[len(out)-1] = c
				continue
			}
		}
		out = append(out, ev.Clone())
	}
	trimmed := out
	if len(out) > MaxTraceEvents {
		trimmed = out[len(out)-MaxTraceEvents:]
	}
	arr := make([]any, len(trimmed))
	for i, e := range trimmed {
		arr[i] = e
	}
	size := Len(util.Stringify(arr))
	for i := 0; i < len(trimmed) && size > MaxTraceBytes; i++ {
		ev := trimmed[i]
		if ev.Get("type") != "tool" {
			continue
		}
		if s := util.Str(ev.Get("output")); s != "" {
			size -= Len(s)
			ev.Delete("output")
		}
		if s := util.Str(ev.Get("input")); size > MaxTraceBytes && s != "" {
			size -= Len(s)
			ev.Delete("input")
		}
	}
	return trimmed
}

func jsEq(a, b any) bool {
	return a == b
}

// CompactOldTraces drops the traces of older messages (list items are messages).
func CompactOldTraces(list []Ev, keepRecent int) bool {
	changed := false
	for i := 0; i < len(list)-keepRecent; i++ {
		tr, ok := list[i].Get("trace").([]any)
		if !ok {
			continue
		}
		for _, x := range tr {
			ev := util.AsObj(x)
			if ev.Get("type") != "tool" {
				continue
			}
			if ev.Has("output") {
				ev.Delete("output")
				changed = true
			}
			if ev.Has("input") {
				ev.Delete("input")
				changed = true
			}
		}
	}
	return changed
}

// MergeUsage merges usage events (nil = undefined).
func MergeUsage(events []Ev) Ev {
	var out Ev
	for _, ev := range events {
		if ev.Get("type") == "done" && util.IsObj(ev.Get("usage")) {
			if out == nil {
				out = util.NewObj()
			}
			out.Assign(util.AsObj(ev.Get("usage")))
		}
	}
	return out
}
