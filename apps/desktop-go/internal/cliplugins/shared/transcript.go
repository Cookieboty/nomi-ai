package shared

import (
	"math"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/reminders"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	HistoryMaxMessages = 300
	MaxText            = 20000
)

type Json = *util.Obj

func o(kv ...any) Json { return util.NewObj(kv...) }

// AsJ = (v ?? {}) as Json：非对象（含数组）一律视为无属性对象。
func AsJ(v any) Json {
	if x, ok := v.(*util.Obj); ok {
		return x
	}
	return o()
}

// Lines mirrors lines()：去 BOM，逐行 trim，'{' 开头且解析为对象的保留（数组视为空对象）。
func Lines(text string) []Json {
	out := []Json{}
	text = strings.TrimPrefix(text, "\uFEFF")
	for _, l := range strings.Split(text, "\n") {
		s := util.JSTrim(l)
		if !strings.HasPrefix(s, "{") {
			continue
		}
		v, err := util.ParseString(s)
		if err != nil {
			continue
		}
		switch x := v.(type) {
		case *util.Obj:
			out = append(out, x)
		case []any:
			out = append(out, o())
		}
	}
	return out
}

// Str mirrors str()：非空字符串。
func NStr(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}

// StrOr = str(a) ?? str(b) ?? ...；全无返回 "", false。
func NStrOr(vs ...any) (string, bool) {
	for _, v := range vs {
		if s, ok := NStr(v); ok {
			return s, true
		}
	}
	return "", false
}

// When mirrors when()。
func When(v any, fallback float64) float64 {
	switch x := v.(type) {
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			if x > 1e12 {
				return x
			}
			return x * 1000
		}
	case string:
		if n, ok := reminders.DateParse(x); ok {
			return n
		}
	}
	return fallback
}

// Nullish = a ?? b ?? ...（nil 即 null/undefined）。
func Nullish(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func isText(t string) bool { return t == "text" || t == "input_text" || t == "output_text" }
func isToolUse(t string) bool {
	return t == "tool_use" || t == "tool-call" || t == "tool_call"
}

func asList(content any) []any {
	switch x := content.(type) {
	case []any:
		return x
	case *util.Obj:
		return []any{x}
	}
	return nil
}

// Blocks mirrors blocks()。
func Blocks(content any) (string, []string) {
	if s, ok := content.(string); ok {
		return s, []string{}
	}
	text := []string{}
	tools := []string{}
	for _, c := range asList(content) {
		x := AsJ(c)
		t := typeOf(x)
		if isText(t) {
			if s, ok := NStr(x.Get("text")); ok {
				text = append(text, s)
			}
			continue
		}
		if isToolUse(t) {
			if n, ok := NStrOr(x.Get("name"), x.Get("tool")); ok {
				tools = append(tools, n)
			}
		}
	}
	return strings.Join(text, "\n\n"), tools
}

func typeOf(x Json) string {
	v := x.Get("type")
	if v == nil {
		return ""
	}
	return util.JSString(v)
}

var (
	injRe1 = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*<(environment_context|user_instructions|INSTRUCTIONS|skills_instructions|system-reminder|local-command-caveat|local-command-stdout)`)
	injRe2 = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*#` + util.JSWhitespace + `*AGENTS\.md`)
	injRe3 = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*\[Request interrupted by user`)
	injRe4 = regexp.MustCompile(`(?i)^` + util.JSWhitespace + `*\[Your previous response had no visible output`)
)

// Injected mirrors injected()。
func Injected(text string) bool {
	t := util.JSIText(text)
	return injRe1.MatchString(t) || injRe2.MatchString(t) || injRe3.MatchString(t) || injRe4.MatchString(t)
}

type ToolStart struct {
	ID, Name string
	Input    any
	At       float64
	ParentID string
}

type ToolEnd struct {
	ID     string
	Output any
	Error  bool
	At     float64
}

// Builder mirrors class Builder。
type Builder struct {
	Out       []Json
	n         int
	names     map[string]string
	turnStart float64
}

func NewBuilder() *Builder { return &Builder{Out: []Json{}, names: map[string]string{}} }

func (b *Builder) id() string {
	s := "hist-" + util.FormatNumber(float64(b.n))
	b.n++
	return s
}

func (b *Builder) User(text string, at float64) {
	content := util.JSTrim(clisdk.StripCarriedContext(text))
	if content == "" || Injected(content) {
		return
	}
	b.turnStart = at
	b.Out = append(b.Out, o("id", b.id(), "role", "user", "content", util.UTF16Slice0(content, MaxText), "timestamp", at))
}

func (b *Builder) current(at float64) Json {
	if len(b.Out) > 0 {
		if last := b.Out[len(b.Out)-1]; last.Get("role") == "assistant" {
			return last
		}
	}
	m := o("id", b.id(), "role", "assistant", "content", "", "timestamp", at)
	b.Out = append(b.Out, m)
	return m
}

func pushArr(m Json, k string, v any) {
	a, _ := m.Get(k).([]any)
	m.Set(k, append(a, v))
}

func (b *Builder) Assistant(text string, tools []string, at float64, usage Json) {
	content := util.JSTrim(text)
	if content == "" && len(tools) == 0 && usage == nil {
		return
	}
	m := b.current(at)
	if content != "" {
		cur := m.Get("content").(string)
		if cur != "" {
			atBreak := util.UTF16Len(cur) + 2
			nc := util.UTF16Slice0(cur+"\n\n"+content, MaxText)
			m.Set("content", nc)
			if atBreak < util.UTF16Len(nc) {
				pushArr(m, "textBreaks", float64(atBreak))
			}
		} else {
			m.Set("content", util.UTF16Slice0(content, MaxText))
		}
	}
	if len(tools) > 0 {
		a, _ := m.Get("tools").([]any)
		a = append([]any{}, a...)
		for _, t := range tools {
			a = append(a, t)
		}
		m.Set("tools", a)
	}
	if usage != nil {
		prev, _ := m.Get("usage").(*util.Obj)
		m.Set("usage", AddUsage(prev, usage))
	}
	m.Set("timestamp", at)
}

func (b *Builder) Thinking(text string, at float64) {
	t := util.JSTrim(text)
	if t == "" {
		return
	}
	m := b.current(at)
	pushArr(m, "trace", o("type", "thinking", "text", util.UTF16Slice0(t, 8000), "at", at, "textAt", float64(util.UTF16Len(m.Get("content").(string)))))
	m.Set("timestamp", at)
}

func (b *Builder) ToolStart(c ToolStart) {
	m := b.current(c.At)
	b.names[c.ID] = c.Name
	ev := o("type", "tool", "name", c.Name, "status", "start", "id", c.ID)
	if in := InputText(c.Input); in != nil {
		ev.Set("input", *in)
	}
	if c.ParentID != "" {
		ev.Set("parentId", c.ParentID)
	}
	ev.Set("at", c.At)
	ev.Set("textAt", float64(util.UTF16Len(m.Get("content").(string))))
	pushArr(m, "trace", ev)
	m.Set("timestamp", c.At)
}

func (b *Builder) ToolEnd(e ToolEnd) {
	m := b.current(e.At)
	name, ok := b.names[e.ID]
	if !ok {
		name = "tool"
	}
	status := "done"
	if e.Error {
		status = "error"
	}
	ev := o("type", "tool", "name", name, "status", status, "id", e.ID)
	if out := OutputText(e.Output); out != nil {
		ev.Set("output", *out)
	}
	ev.Set("at", e.At)
	pushArr(m, "trace", ev)
	m.Set("timestamp", e.At)
}

func (b *Builder) Result() []Json {
	userAt := 0.0
	for _, m := range b.Out {
		ts := m.Get("timestamp").(float64)
		if m.Get("role") == "user" {
			userAt = ts
			continue
		}
		if tr, ok := m.Get("trace").([]any); ok {
			evs := make([]clisdk.Ev, 0, len(tr))
			for _, x := range tr {
				evs = append(evs, x.(*util.Obj))
			}
			trace := clisdk.BuildTrace(evs)
			if len(trace) > 0 {
				a := make([]any, len(trace))
				for i, x := range trace {
					a[i] = x
				}
				m.Set("trace", a)
			} else {
				m.Delete("trace")
			}
		}
		if userAt != 0 && ts > userAt {
			m.Set("durationMs", ts-userAt)
		}
	}
	if len(b.Out) > HistoryMaxMessages {
		return b.Out[len(b.Out)-HistoryMaxMessages:]
	}
	return b.Out
}

// AddUsage mirrors addUsage。
func AddUsage(a, b Json) Json {
	out := o()
	if a != nil {
		out.Assign(a)
	}
	if b.Has("inputTokens") {
		out.Set("inputTokens", b.Get("inputTokens"))
	}
	if b.Has("cacheReadTokens") {
		out.Set("cacheReadTokens", b.Get("cacheReadTokens"))
	}
	if b.Has("outputTokens") {
		prev, _ := out.Get("outputTokens").(float64)
		out.Set("outputTokens", prev+b.Get("outputTokens").(float64))
	}
	if b.Has("contextTokens") {
		out.Set("contextTokens", b.Get("contextTokens"))
	}
	return out
}

func toolName(x Json) (string, bool) { return NStrOr(x.Get("name"), x.Get("tool"), x.Get("toolName")) }

func toolCallID(x Json, at float64, name string) string {
	if id, ok := NStrOr(x.Get("id"), x.Get("toolCallId"), x.Get("call_id")); ok {
		return id
	}
	return "t-" + util.FormatNumber(at) + "-" + name
}

func toolResult(b *Builder, x Json, at float64) {
	if id, ok := NStrOr(x.Get("tool_use_id"), x.Get("toolCallId"), x.Get("call_id")); ok {
		b.ToolEnd(ToolEnd{ID: id, Output: Nullish(x.Get("content"), x.Get("output"), x.Get("result")),
			Error: x.Get("is_error") == true || x.Get("isError") == true, At: at})
	}
}

// FeedBlocks mirrors feedBlocks。
func FeedBlocks(b *Builder, content any, at float64, parentID string) {
	list, ok := content.([]any)
	if !ok {
		return
	}
	for _, c := range list {
		x := AsJ(c)
		t := typeOf(x)
		switch {
		case t == "thinking":
			if s, ok := NStr(x.Get("thinking")); ok {
				b.Thinking(s, at)
			}
		case t == "reasoning":
			if s, ok := NStr(x.Get("text")); ok {
				b.Thinking(s, at)
			}
		case isToolUse(t):
			name, ok := toolName(x)
			if !ok {
				continue
			}
			b.ToolStart(ToolStart{ID: toolCallID(x, at, name), Name: name, Input: Nullish(x.Get("input"), x.Get("args"), x.Get("arguments")), At: at, ParentID: parentID})
		case t == "tool_result" || t == "tool-result":
			toolResult(b, x, at)
		}
	}
}

// WalkAssistant mirrors walkAssistant。
func WalkAssistant(b *Builder, content any, at float64, usage Json) {
	list, ok := content.([]any)
	if !ok {
		s, _ := content.(string)
		b.Assistant(s, nil, at, usage)
		return
	}
	names := []string{}
	for _, c := range list {
		x := AsJ(c)
		t := typeOf(x)
		switch {
		case isText(t):
			if s, ok := NStr(x.Get("text")); ok {
				b.Assistant(s, nil, at, nil)
			}
		case t == "thinking":
			if s, ok := NStr(x.Get("thinking")); ok {
				b.Thinking(s, at)
			}
		case t == "reasoning":
			if s, ok := NStr(x.Get("text")); ok {
				b.Thinking(s, at)
			}
		case isToolUse(t):
			name, ok := toolName(x)
			if !ok {
				continue
			}
			b.ToolStart(ToolStart{ID: toolCallID(x, at, name), Name: name, Input: Nullish(x.Get("input"), x.Get("args"), x.Get("arguments")), At: at})
			names = append(names, name)
		case t == "tool_result" || t == "tool-result":
			toolResult(b, x, at)
		}
	}
	if len(names) > 0 {
		b.Assistant("", names, at, nil)
	}
	if usage != nil {
		b.Assistant("", nil, at, usage)
	}
}

// UsageOf mirrors usageOf（nil = undefined）。
func UsageOf(u Json) Json {
	n := func(k string) (float64, bool) {
		v, ok := u.Get(k).(float64)
		return v, ok && !math.IsInf(v, 0) && !math.IsNaN(v) && v >= 0
	}
	pick := func(a, b string) (float64, bool) {
		if v, ok := n(a); ok {
			return v, true
		}
		return n(b)
	}
	out := o()
	in, hi := pick("input_tokens", "inputTokens")
	op, ho := pick("output_tokens", "outputTokens")
	ca, hc := pick("cache_read_input_tokens", "cacheReadTokens")
	if hi {
		out.Set("inputTokens", in)
	}
	if ho {
		out.Set("outputTokens", op)
	}
	if hc {
		out.Set("cacheReadTokens", ca)
	}
	cr, hcr := n("cache_creation_input_tokens")
	if u.Has("input_tokens") || u.Has("cache_read_input_tokens") || hcr {
		out.Set("contextTokens", in+ca+cr+op)
	}
	if out.Len() == 0 {
		return nil
	}
	return out
}

// TitleFromMessages mirrors titleFromMessages。
func TitleFromMessages(msgs []Json) *string {
	for _, m := range msgs {
		if m.Get("role") == "user" {
			return CleanTitle(m.Get("content").(string), 80)
		}
	}
	return nil
}

var sessionExtRe = regexp.MustCompile(`\.jsonl(?:\.zstd?)?$`)

func sessionIDOf(f clisdk.HistoryFileRef) string {
	if f.DirID != "" {
		return f.DirID
	}
	return sessionExtRe.ReplaceAllString(filepath.Base(f.Path), "") // path.basename（按平台分隔符）
}

// TranscriptParser = (text, fallbackAt) => HarnessTabMessage[]。
type TranscriptParser func(text string, fallbackAt float64) []Json

// HistoryParse mirrors historyParse：返回 HistoryParse Obj。
func HistoryParse(formatHint string, parse TranscriptParser) func(text string, f clisdk.HistoryFileRef) Json {
	return func(text string, f clisdk.HistoryFileRef) Json {
		msgs := parse(text, f.Mtime)
		if len(msgs) == 0 && util.JSTrim(text) != "" {
			return o("error", "no messages recognised", "formatHint", formatHint)
		}
		meta := o("sessionId", sessionIDOf(f))
		if t := TitleFromMessages(msgs); t != nil && *t != "" {
			meta.Set("title", *t)
		}
		ms := make([]any, len(msgs))
		for i, m := range msgs {
			ms[i] = o("role", m.Get("role"), "content", m.Get("content"))
		}
		return o("meta", meta, "messages", ms)
	}
}
