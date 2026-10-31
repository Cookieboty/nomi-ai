package drivers

import (
	"math"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type Json = *util.Obj

var kindTool = map[string]string{
	"read": "read_file", "edit": "edit", "delete": "delete_file", "move": "move_file",
	"search": "search", "execute": "run_shell_command", "fetch": "web_fetch", "switch_mode": "exit_plan_mode",
}

func clip(s string, n int) string {
	if clisdk.Len(s) > n {
		return clisdk.Slice0(s, n) + "…"
	}
	return s
}

// strQ = String(v ?? ”)。
func strQ(v any) string {
	if v == nil {
		return ""
	}
	return util.JSString(v)
}

func getp(v any, k string) any {
	if o, ok := v.(*util.Obj); ok {
		return o.Get(k)
	}
	return nil
}

func contentText(content any) string {
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	var out []string
	for _, c := range arr {
		switch getp(c, "type") {
		case "content":
			inner := getp(c, "content")
			if getp(inner, "type") == "text" {
				if t, ok := getp(inner, "text").(string); ok {
					out = append(out, t)
				}
			}
		case "diff":
			if p, ok := getp(c, "path").(string); ok {
				nt, _ := getp(c, "newText").(string)
				out = append(out, "--- "+p+"\n+++ "+p+"\n"+nt)
			}
		}
	}
	return strings.Join(out, "\n")
}

var agentTitle = regexp.MustCompile(`(?i)agent|subagent|delegat`)

func firstWord(title string) string {
	// title.split(/\s/)[0]
	for i, r := range title {
		if isJSSpace(r) {
			return title[:i]
		}
	}
	return title
}

func isJSSpace(r rune) bool { return clisdk.JSTrim(string(r)) == "" }

func toolName(kind, title string) string {
	if kind == "think" && agentTitle.MatchString(title) {
		return "invoke_agent"
	}
	if t, ok := kindTool[kind]; ok {
		return t
	}
	if kind == "think" {
		return "think"
	}
	if w := firstWord(title); w != "" {
		return w
	}
	return "tool"
}

// AcpMapper mirrors ReturnType<typeof createAcpMapper>。
type AcpMapper interface {
	Update(u Json) []Ev
	Flush() []Ev
	Context() Json
}

type acpMapper struct {
	thought string
	context Json
	names   map[string]string
}

// NewAcpMapper mirrors createAcpMapper（= createGeminiMapper）。
func NewAcpMapper() AcpMapper { return &acpMapper{context: O(), names: map[string]string{}} }

func (m *acpMapper) Flush() []Ev {
	if clisdk.JSTrim(m.thought) == "" {
		return []Ev{}
	}
	ev := O("type", "thinking", "text", clip(m.thought, 20_000))
	m.thought = ""
	return []Ev{ev}
}

func (m *acpMapper) Context() Json { return m.context }

func posNum(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f > 0
}

// compactTokensAfter mirrors compactTokensAfter：auto_compact_completed 的 tokens_after（兼容驼峰）。
func compactTokensAfter(u Json) (float64, bool) {
	v := u.Get("tokens_after")
	if v == nil {
		v = u.Get("tokensAfter")
	}
	f, ok := v.(float64)
	return f, ok && !math.IsInf(f, 0) && !math.IsNaN(f) && f >= 0
}

func (m *acpMapper) Update(u Json) []Ev {
	kind := strQ(u.Get("sessionUpdate"))
	// Grok 自动压缩（x.ai 扩展通知）：started → 压缩中；completed → 清状态 + 压缩后的占用；
	// failed / cancelled → 只清状态
	if strings.HasPrefix(kind, "auto_compact_") {
		if kind == "auto_compact_started" {
			return []Ev{O("type", "status", "kind", "compact")}
		}
		if kind != "auto_compact_completed" {
			return []Ev{O("type", "status", "kind", "clear")}
		}
		after, ok := compactTokensAfter(u)
		next := O()
		if ok {
			next = m.context.Clone()
			next.Set("contextTokens", after)
		} else if w := m.context.Get("contextWindow"); w != nil {
			// 没给压缩后的大小：旧占用作废，只留窗口
			next.Set("contextWindow", w)
		}
		m.context = next
		var tok any
		if ok {
			tok = after
		}
		return []Ev{O("type", "status", "kind", "clear"), O("type", "context", "tokens", tok)}
	}
	if kind == "agent_thought_chunk" {
		if t, ok := getp(u.Get("content"), "text").(string); ok {
			m.thought += t
		}
		return []Ev{}
	}
	if kind == "usage_update" {
		used, okU := posNum(u.Get("used"))
		size, okS := posNum(u.Get("size"))
		m.context = O()
		if okU {
			m.context.Set("contextTokens", used)
		}
		if okS {
			m.context.Set("contextWindow", size)
		}
		if !okU {
			return []Ev{}
		}
		ev := O("type", "context", "tokens", used)
		if okS {
			ev.Set("window", size)
		}
		return []Ev{ev}
	}
	out := m.Flush()
	if kind == "agent_message_chunk" {
		c := u.Get("content")
		if getp(c, "type") == "text" {
			if t, ok := getp(c, "text").(string); ok && t != "" {
				out = append(out, O("type", "text-delta", "text", t))
			}
		}
		return out
	}
	if kind == "tool_call" || kind == "tool_call_update" {
		id := strQ(u.Get("toolCallId"))
		if id == "" {
			return out
		}
		title, _ := u.Get("title").(string)
		status := strQ(u.Get("status"))
		terminal := status == "completed" || status == "failed"
		if _, has := m.names[id]; !terminal && kind == "tool_call_update" && has {
			return out
		}
		name, has := m.names[id]
		if !has {
			meta := getp(u.Get("_meta"), "x.ai/tool")
			if n, ok := getp(meta, "name").(string); ok && n != "" {
				name = n
			} else {
				name = toolName(strQ(u.Get("kind")), title)
			}
		}
		m.names[id] = name
		var loc any
		if arr, ok := u.Get("locations").([]any); ok && len(arr) > 0 {
			loc = arr[0]
		}
		var input string
		raw := u.Get("rawInput")
		if _, isObj := raw.(*util.Obj); isObj {
			input = util.Stringify(raw)
		} else if _, isArr := raw.([]any); isArr {
			input = util.Stringify(raw)
		} else {
			o := O()
			if title != "" {
				o.Set("description", title)
			}
			if p, ok := getp(loc, "path").(string); ok {
				o.Set("path", p)
			}
			input = util.Stringify(o)
		}
		if terminal {
			delete(m.names, id)
			st := "done"
			if status == "failed" {
				st = "error"
			}
			ev := O("type", "tool", "name", name, "status", st, "detail", id, "input", input)
			if o := clip(contentText(u.Get("content")), 20_000); o != "" {
				ev.Set("output", o)
			}
			out = append(out, ev)
		} else {
			out = append(out, O("type", "tool", "name", name, "status", "start", "detail", id, "input", input))
		}
		return out
	}
	return out
}

// PickPermissionOption mirrors pickPermissionOption（"" + false = null）。
func PickPermissionOption(options any, allow bool) (string, bool) {
	list, ok := options.([]any)
	if !ok {
		return "", false
	}
	want := []string{"reject_once", "reject_always"}
	if allow {
		want = []string{"allow_once", "allow_always"}
	}
	for _, k := range want {
		for _, o := range list {
			if o == nil { // JS：null/undefined 元素上读 .kind 抛 TypeError
				panic(clisdk.JSThrow{Name: "TypeError", Message: "Cannot read properties of " + nullName(o) + " (reading 'kind')"})
			}
			if getp(o, "kind") == k {
				if id, ok := getp(o, "optionId").(string); ok {
					return id, true
				}
			}
		}
	}
	return "", false
}

// PermissionSummary mirrors permissionSummary。
func PermissionSummary(params Json) string {
	call := params.Get("toolCall")
	title, ok := getp(call, "title").(string)
	if !ok {
		title = "tool"
	}
	var loc any
	if arr, ok := getp(call, "locations").([]any); ok && len(arr) > 0 {
		loc = arr[0]
	}
	if p, ok := getp(loc, "path").(string); ok {
		return clip(title+": "+p, 200)
	}
	return clip(title, 200)
}

var NewGeminiMapper = NewAcpMapper

// nullName：Go nil 无法区分 null/undefined；JSON 来源的数组元素只可能是 null。
func nullName(any) string { return "null" }
