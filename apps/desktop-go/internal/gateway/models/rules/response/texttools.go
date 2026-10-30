package response

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	dsml      = "<｜DSML｜"
	dsmlClose = "</｜DSML｜"
	maxMarker = 11 // max UTF-16 length of markers ('<tool_call>')
)

var markers = []string{"<tool_call>", dsml, "<arg_key>"}

// TextToolCall is TextToolCall.
type TextToolCall struct{ Name, Args string }

// Resolve maps a model-written name to a provided tool name ("" = unknown).
type Resolve func(name string) string

const ws = "[" + u.JSWS + "]"

var (
	glmPairRe   = regexp.MustCompile(`^` + ws + `*<arg_key>([\s\S]*?)</arg_key>` + ws + `*<arg_value>([\s\S]*?)</arg_value>`)
	dsmlParamRe = regexp.MustCompile(`^` + ws + `*<｜DSML｜parameter` + ws + `+name="([^"]*)"(?:` + ws + `+string="(true|false)")?` + ws + `*>([\s\S]*?)</｜DSML｜parameter>`)
	dsmlInvRe   = regexp.MustCompile(`^<｜DSML｜invoke` + ws + `+name="([^"]*)"` + ws + `*>`)
	dsmlWrapRe  = regexp.MustCompile(`^</?｜DSML｜function_calls>`)
	lastWordRe  = regexp.MustCompile(`([A-Za-z0-9_.:-]+)` + ws + `*$`)
)

func parseValueTT(raw string, forceString bool) any {
	if forceString {
		return raw
	}
	v, err := u.ParseString(u.JSTrim(raw))
	if err != nil {
		return raw
	}
	return v
}

var entityRepl = strings.NewReplacer("&lt;", "<", "&gt;", ">", "&quot;", "\"")

func decodeEntities(s string) string {
	return strings.ReplaceAll(entityRepl.Replace(s), "&amp;", "&")
}

func parseToolCallBody(body string, resolve Resolve) *TextToolCall {
	t := u.JSTrim(body)
	if strings.HasPrefix(t, "{") {
		j, err := u.ParseString(t)
		if err != nil {
			return nil
		}
		o, ok := j.(*u.Obj)
		if !ok {
			return nil
		}
		fn := o
		if f := o.Get("function"); u.Truthy(f) {
			switch fv := f.(type) {
			case *u.Obj:
				fn = fv
			case []any:
				fn = u.NewObj()
			}
		}
		name := resolve(u.Str(fn.Get("name")))
		if name == "" {
			return nil
		}
		args := fn.Get("arguments")
		if args == nil {
			args = fn.Get("parameters")
		}
		if args == nil {
			args = fn.Get("args")
		}
		if args == nil {
			args = u.NewObj()
		}
		if s, ok := args.(string); ok {
			v, err := u.ParseString(s)
			if err != nil {
				return nil
			}
			args = v
		}
		if _, ok := args.(*u.Obj); !ok {
			return nil
		}
		return &TextToolCall{Name: name, Args: u.Stringify(args)}
	}
	i := strings.Index(t, "<arg_key>")
	if i < 0 {
		return glmCall(t, "", resolve)
	}
	return glmCall(t[:i], t[i:], resolve)
}

func glmCall(rawName, pairs string, resolve Resolve) *TextToolCall {
	name := resolve(u.JSTrim(rawName))
	if name == "" {
		return nil
	}
	args := u.NewObj()
	pos := 0
	for pos < len(pairs) {
		m := glmPairRe.FindStringSubmatchIndex(pairs[pos:])
		if m == nil {
			break
		}
		k := pairs[pos+m[2] : pos+m[3]]
		v := pairs[pos+m[4] : pos+m[5]]
		args.Set(u.JSTrim(k), parseValueTT(v, false))
		pos += m[1]
	}
	if u.JSTrim(pairs[pos:]) != "" {
		return nil
	}
	return &TextToolCall{Name: name, Args: u.Stringify(args)}
}

func dsmlCall(name, body string, resolve Resolve) *TextToolCall {
	n := resolve(decodeEntities(name))
	if n == "" {
		return nil
	}
	args := u.NewObj()
	pos := 0
	for pos < len(body) {
		m := dsmlParamRe.FindStringSubmatchIndex(body[pos:])
		if m == nil {
			break
		}
		k := body[pos+m[2] : pos+m[3]]
		force := m[4] >= 0 && body[pos+m[4]:pos+m[5]] == "true"
		args.Set(decodeEntities(k), parseValueTT(body[pos+m[6]:pos+m[7]], force))
		pos += m[1]
	}
	if u.JSTrim(body[pos:]) != "" {
		return nil
	}
	return &TextToolCall{Name: n, Args: u.Stringify(args)}
}

type ttBlock struct {
	start, end int
	call       *TextToolCall
}

func indexFrom(s, sub string, from int) int {
	if from > len(s) {
		return -1
	}
	i := strings.Index(s[from:], sub)
	if i < 0 {
		return -1
	}
	return i + from
}

func findBlocks(s string, resolve Resolve, leadName *string) []ttBlock {
	var out []ttBlock
	pos := 0
	for {
		at := -1
		for _, m := range append(append([]string{}, markers...), dsmlClose) {
			if i := indexFrom(s, m, pos); i >= 0 && (at < 0 || i < at) {
				at = i
			}
		}
		if at < 0 {
			break
		}
		rest := s[at:]
		switch {
		case strings.HasPrefix(rest, "<tool_call>"):
			close := indexFrom(s, "</tool_call>", at)
			bodyEnd, end := len(s), len(s)
			if close >= 0 {
				bodyEnd, end = close, close+len("</tool_call>")
			}
			out = append(out, ttBlock{at, end, parseToolCallBody(s[at+11:bodyEnd], resolve)})
			pos = end
		case strings.HasPrefix(rest, dsml+"invoke"):
			m := dsmlInvRe.FindStringSubmatchIndex(rest)
			close := indexFrom(s, "</｜DSML｜invoke>", at)
			if m == nil || close < 0 {
				out = append(out, ttBlock{at, len(s), nil})
				return out
			}
			end := close + len("</｜DSML｜invoke>")
			out = append(out, ttBlock{at, end, dsmlCall(rest[m[2]:m[3]], s[at+m[1]:close], resolve)})
			pos = end
		case strings.HasPrefix(rest, dsml) || strings.HasPrefix(rest, dsmlClose):
			m := dsmlWrapRe.FindStringIndex(rest)
			var end int
			var call *TextToolCall
			if m != nil {
				end = at + m[1]
				call = &TextToolCall{}
			} else if strings.HasPrefix(rest, dsml) {
				end = at + len(dsml)
			} else {
				end = at + len(dsmlClose)
			}
			out = append(out, ttBlock{at, end, call})
			pos = end
		default:
			close := strings.LastIndex(s, "</arg_value>")
			end := len(s)
			if close >= at {
				end = close + len("</arg_value>")
			}
			before := lastWordRe.FindStringSubmatchIndex(s[pos:at])
			start := at
			var name *string
			if before != nil {
				start = pos + before[0]
				w := s[pos+before[2] : pos+before[3]]
				name = &w
			} else if at == 0 {
				name = leadName
			}
			var call *TextToolCall
			if name != nil {
				call = glmCall(*name, s[at:end], resolve)
			}
			out = append(out, ttBlock{start, end, call})
			pos = end
		}
	}
	return out
}

// TextToolExtractor is TextToolExtractor.
type TextToolExtractor struct {
	buffering       bool
	buf, hold, tail string
	leadName        *string
	resolve         Resolve
}

// NewTextToolExtractor creates the extractor.
func NewTextToolExtractor(resolve Resolve) *TextToolExtractor {
	return &TextToolExtractor{resolve: resolve}
}

// Active is `active`.
func (x *TextToolExtractor) Active() bool { return x.buffering || x.hold != "" }

// Push returns the text that may be emitted now.
func (x *TextToolExtractor) Push(text string) string {
	if x.buffering {
		x.buf += text
		return ""
	}
	s := x.hold + text
	x.hold = ""
	at := -1
	for _, m := range markers {
		if i := strings.Index(s, m); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at >= 0 {
		if strings.HasPrefix(s[at:], "<arg_key>") {
			pre := x.tail + s[:at]
			if m := lastWordRe.FindStringSubmatchIndex(pre); m != nil {
				if m[0] >= len(x.tail) {
					at = m[0] - len(x.tail)
				} else {
					w := pre[m[2]:m[3]]
					x.leadName = &w
				}
			}
		}
		x.buffering = true
		x.buf = s[at:]
		return x.emit(s[:at])
	}
	n16 := u.UTF16Len(s) - maxMarker + 1
	if n16 < 0 {
		n16 = 0
	}
	for i := indexFrom(s, "<", u.UTF16Prefix(s, n16)); i >= 0; i = indexFrom(s, "<", i+1) {
		tail := s[i:]
		for _, m := range markers {
			if strings.HasPrefix(m, tail) {
				x.hold = tail
				return x.emit(s[:i])
			}
		}
	}
	return x.emit(s)
}

func (x *TextToolExtractor) emit(s string) string {
	x.tail = u.UTF16Tail(x.tail+s, 128)
	return s
}

// Raw gives back the buffered text unparsed.
func (x *TextToolExtractor) Raw() string {
	s := x.hold
	if x.buffering {
		s = x.buf
	}
	x.buffering, x.buf, x.hold, x.leadName = false, "", "", nil
	return s
}

// Flush parses the buffer.
func (x *TextToolExtractor) Flush() (string, []TextToolCall) {
	s := x.hold
	was := x.buffering
	if was {
		s = x.buf
	}
	x.buffering, x.buf, x.hold = false, "", ""
	if !was {
		return s, nil
	}
	blocks := findBlocks(s, x.resolve, x.leadName)
	x.leadName = nil
	invokesOk := true
	for _, b := range blocks {
		if b.call == nil {
			invokesOk = false
		}
	}
	var calls []TextToolCall
	var text strings.Builder
	pos := 0
	for _, b := range blocks {
		text.WriteString(s[pos:b.start])
		wrapper := b.call != nil && b.call.Name == ""
		if b.call != nil && !wrapper {
			calls = append(calls, *b.call)
		} else if !(wrapper && invokesOk) {
			text.WriteString(s[b.start:b.end])
		}
		pos = b.end
	}
	text.WriteString(s[pos:])
	t := text.String()
	if len(calls) > 0 {
		t = u.JSTrimEnd(t)
	}
	return t, calls
}
