package cli

import (
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const transcriptTailBytes = 8 * 1024 * 1024

func isCJK(r rune) bool {
	return (r >= 0x2e80 && r <= 0x9fff) || (r >= 0xac00 && r <= 0xd7af) || (r >= 0xff00 && r <= 0xffef) || (r >= 0x3040 && r <= 0x30ff)
}

func estimateTokens(text string) float64 {
	if text == "" {
		return 0
	}
	cjk, other := 0.0, 0.0
	for _, r := range text {
		if isCJK(r) {
			cjk++
		} else {
			other++
		}
	}
	return math.Ceil(cjk + other/4)
}

func blockText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if a, ok := v.([]any); ok {
		parts := make([]string, len(a))
		for i, b := range a {
			if o, ok := b.(*util.Obj); ok {
				if s, ok := o.Get("text").(string); ok {
					parts[i] = s
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

type tcats struct{ user, assistant, tools, thinking float64 }

func (c *tcats) sum() float64 { return c.user + c.assistant + c.tools + c.thinking }

func strOr(v any) string { return strOrEmpty(v) }

func lineCategories(j *util.Obj, into *tcats) {
	var content any
	if m, ok := j.Get("message").(*util.Obj); ok {
		content = m.Get("content")
	}
	switch j.Get("type") {
	case "user":
		if s, ok := content.(string); ok {
			into.user += estimateTokens(s)
		} else if a, ok := content.([]any); ok {
			for _, bv := range a {
				b, _ := bv.(*util.Obj)
				if b == nil {
					continue
				}
				switch b.Get("type") {
				case "tool_result":
					into.tools += estimateTokens(blockText(b.Get("content")))
				case "text":
					into.user += estimateTokens(strOr(b.Get("text")))
				}
			}
		}
	case "assistant":
		if a, ok := content.([]any); ok {
			for _, bv := range a {
				b, _ := bv.(*util.Obj)
				if b == nil {
					continue
				}
				switch b.Get("type") {
				case "text":
					into.assistant += estimateTokens(strOr(b.Get("text")))
				case "thinking":
					into.thinking += estimateTokens(strOr(b.Get("thinking")))
				case "tool_use":
					in := b.Get("input")
					if in == nil {
						in = ""
					}
					into.tools += estimateTokens(strOr(b.Get("name")) + " " + util.Stringify(in))
				}
			}
		}
	}
}

func tnum(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0, false
	}
	return f, true
}

var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

// ClaudeProjectDirName = claudeProjectDirName（按 UTF-16 码元替换：非 BMP 字符为两个 '-'）。
func ClaudeProjectDirName(cwd string) string {
	var b strings.Builder
	for _, r := range cwd {
		switch {
		case r < 0x80 && !nonAlnum.MatchString(string(r)):
			b.WriteRune(r)
		case r > 0xffff:
			b.WriteString("--")
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

func readTail(file string) (string, bool) {
	f, err := os.Open(file)
	if err != nil {
		return "", false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", false
	}
	size := st.Size()
	start := size - transcriptTailBytes
	if start < 0 {
		start = 0
	}
	buf := make([]byte, size-start)
	if _, err := f.ReadAt(buf, start); err != nil && err != io.EOF {
		return "", false
	}
	text := strings.ToValidUTF8(string(buf), "\uFFFD")
	if start > 0 {
		text = text[strings.Index(text, "\n")+1:]
	}
	return text, true
}

func requestContext(u *util.Obj) (float64, bool) {
	if u == nil {
		return 0, false
	}
	any_, s := false, 0.0
	for _, k := range []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"} {
		if v, ok := tnum(u.Get(k)); ok {
			any_ = true
			s += v
		}
	}
	if !any_ || s == 0 {
		return 0, false
	}
	return s, true
}

func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// LastTranscriptContext = lastTranscriptContext（nil = null）。
func LastTranscriptContext(text string) *util.Obj {
	lines := strings.Split(text, "\n")
	from := 0
	var boundaryPost float64
	hasBoundary := false
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !strings.Contains(line, `"compact_boundary"`) {
			continue
		}
		v, err := util.ParseString(line)
		j, ok := v.(*util.Obj)
		if err != nil || !ok {
			continue
		}
		if j.Get("type") != "system" || j.Get("subtype") != "compact_boundary" {
			continue
		}
		mv := j.Get("compactMetadata")
		if mv == nil {
			mv = j.Get("compact_metadata")
		}
		meta, _ := mv.(*util.Obj)
		if meta == nil {
			meta = util.NewObj()
		}
		if p, ok := tnum(meta.Get("postTokens")); ok {
			boundaryPost, hasBoundary = p, true
		} else if p, ok := tnum(meta.Get("post_tokens")); ok {
			boundaryPost, hasBoundary = p, true
		}
		from = i + 1
		break
	}
	cats := &tcats{}
	var last *struct {
		ctx   float64
		model string
	}
	var first *struct{ ctx, before, output float64 }
	for i := from; i < len(lines); i++ {
		line := util.JSTrim(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		v, err := util.ParseString(line)
		j, ok := v.(*util.Obj)
		if err != nil || !ok {
			continue
		}
		if j.Get("isSidechain") == true {
			continue
		}
		if j.Get("type") == "assistant" && j.Get("isApiErrorMessage") != true {
			msg, _ := j.Get("message").(*util.Obj)
			if msg == nil {
				msg = util.NewObj()
			}
			usage, _ := msg.Get("usage").(*util.Obj)
			if ctx, ok := requestContext(usage); ok {
				if first == nil {
					out, _ := tnum(usage.Get("output_tokens"))
					first = &struct{ ctx, before, output float64 }{ctx, cats.sum(), out}
				}
				model := ""
				if m, ok := msg.Get("model").(string); ok && !strings.HasPrefix(m, "<") {
					model = m
				}
				if model == "" && last != nil {
					model = last.model
				}
				last = &struct {
					ctx   float64
					model string
				}{ctx, model}
			}
		}
		lineCategories(j, cats)
	}
	var total float64
	if last != nil {
		total = last.ctx
	} else if hasBoundary {
		total = boundaryPost
	}
	if total == 0 {
		return nil
	}
	est := cats.sum()
	var sys float64
	if first != nil {
		sys = first.ctx - first.output - first.before
	} else {
		sys = total - est
	}
	sys = math.Max(0, math.Min(total, sys))
	k := 0.0
	if est > 0 {
		k = math.Max(0, total-sys) / est
	}
	breakdown := util.NewObj("system", jsRound(sys), "user", jsRound(cats.user*k), "assistant", jsRound(cats.assistant*k),
		"tools", jsRound(cats.tools*k), "thinking", jsRound(cats.thinking*k))
	o := util.NewObj("contextTokens", total)
	if last != nil && last.model != "" {
		o.Set("model", last.model)
	}
	if last == nil {
		o.Set("compacted", true)
	}
	o.Set("breakdown", breakdown)
	return o
}

func findTranscript(configDir, cwd, sessionID string) string {
	root := filepath.Join(configDir, "projects")
	name := sessionID + ".jsonl"
	direct := filepath.Join(root, ClaudeProjectDirName(cwd), name)
	if _, err := os.Stat(direct); err == nil {
		return direct
	}
	ents, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, d := range ents {
		if !d.IsDir() {
			continue
		}
		p := filepath.Join(root, d.Name(), name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

var sessionIDRe = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)

type tcEntry struct {
	key   string
	value *util.Obj
}

var (
	tcMu    sync.Mutex
	tcCache = map[string]tcEntry{}
)

// ClaudeTranscriptContext = claudeTranscriptContext（阻塞；nil = null）。
func ClaudeTranscriptContext(configDir, cwd, sessionID string) *util.Obj {
	if !sessionIDRe.MatchString(sessionID) {
		return nil
	}
	file := findTranscript(configDir, cwd, sessionID)
	if file == "" {
		return nil
	}
	st, err := os.Stat(file)
	if err != nil {
		return nil
	}
	key := util.FormatNumber(float64(st.Size())) + ":" + util.FormatNumber(float64(st.ModTime().UnixNano())/1e6)
	tcMu.Lock()
	hit, ok := tcCache[file]
	tcMu.Unlock()
	if ok && hit.key == key {
		return hit.value
	}
	var value *util.Obj
	if tail, ok := readTail(file); ok && tail != "" {
		value = LastTranscriptContext(tail)
	}
	tcMu.Lock()
	if len(tcCache) > 32 {
		tcCache = map[string]tcEntry{}
	}
	tcCache[file] = tcEntry{key, value}
	tcMu.Unlock()
	return value
}

// ClaudeRewindPoint = claudeRewindPoint（"" = null）。
func ClaudeRewindPoint(configDir, cwd, sessionID, userUUID string) string {
	if !sessionIDRe.MatchString(sessionID) {
		return ""
	}
	file := findTranscript(configDir, cwd, sessionID)
	if file == "" {
		return ""
	}
	b, err := os.ReadFile(file)
	if err != nil || len(b) == 0 {
		return ""
	}
	answered := false
	for _, line := range strings.Split(strings.ToValidUTF8(string(b), "\uFFFD"), "\n") {
		if !strings.Contains(line, `"uuid"`) {
			continue
		}
		v, err := util.ParseString(line)
		if err != nil {
			continue
		}
		j, ok := v.(*util.Obj)
		if !ok {
			// JSON.parse 成功但非对象：属性读取均为 undefined
			continue
		}
		if j.Get("isSidechain") == true {
			continue
		}
		if j.Get("type") == "user" && j.Get("uuid") == userUUID {
			if p, ok := j.Get("parentUuid").(string); answered && ok {
				return p
			}
			return ""
		}
		if j.Get("type") == "assistant" {
			answered = true
		}
	}
	return ""
}
