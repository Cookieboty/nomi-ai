// Package sse mirrors apps/desktop-electron/internal/gateway/src/stream/sse.ts: a byte-exact SSE
// block splitter and an event parser. It is a leaf package so canonical/ can
// use it without importing stream/ (deviation D15: Go forbids the import cycle
// Node has between stream/ and canonical/).
package sse

import (
	"regexp"
	"strings"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Event is SseEvent: Event is nil when the block had no `event:` line.
type Event struct {
	Event *string
	Data  string
}

// Block is SseBlock: body without the separator, plus the separator itself.
type Block struct {
	Body string
	Sep  string
}

var sepRe = regexp.MustCompile(`\r?\n\r?\n`)

// Splitter is SseSplitter.
type Splitter struct {
	parts []string
	tail  string
}

func last3(s string) string {
	if len(s) <= 3 {
		return s
	}
	return s[len(s)-3:]
}

// Push returns every complete block in chunk (plus buffered text).
func (s *Splitter) Push(chunk string) []Block {
	if chunk == "" {
		return nil
	}
	if len(s.parts) > 0 && !sepRe.MatchString(s.tail+chunk) {
		s.parts = append(s.parts, chunk)
		s.tail = last3(s.tail + chunk)
		return nil
	}
	prev := strings.Join(s.parts, "")
	buf := prev + chunk
	var out []Block
	start := 0
	from := len(prev) - 3
	if from < 0 {
		from = 0
	}
	for _, m := range sepRe.FindAllStringIndex(buf[from:], -1) {
		a, b := m[0]+from, m[1]+from
		out = append(out, Block{Body: buf[start:a], Sep: buf[a:b]})
		start = b
	}
	rest := buf[start:]
	if rest != "" {
		s.parts = []string{rest}
	} else {
		s.parts = nil
	}
	s.tail = last3(rest)
	return out
}

// PushRaw returns complete blocks verbatim (body + separator).
func (s *Splitter) PushRaw(chunk string) string {
	var b strings.Builder
	for _, bl := range s.Push(chunk) {
		b.WriteString(bl.Body)
		b.WriteString(bl.Sep)
	}
	return b.String()
}

// Take drains the unterminated remainder.
func (s *Splitter) Take() string {
	rest := strings.Join(s.parts, "")
	s.parts = nil
	s.tail = ""
	return rest
}

// Parser is SseParser.
type Parser struct{ split Splitter }

// Push parses complete events out of chunk.
func (p *Parser) Push(chunk string) []Event {
	var out []Event
	for _, b := range p.split.Push(chunk) {
		if ev, ok := parseBlock(b.Body); ok {
			out = append(out, ev)
		}
	}
	return out
}

// End flushes a trailing event without a blank-line terminator.
func (p *Parser) End() []Event {
	rest := p.split.Take()
	if u.JSTrim(rest) == "" {
		return nil
	}
	if ev, ok := parseBlock(rest); ok {
		return []Event{ev}
	}
	return nil
}

var lineRe = regexp.MustCompile(`\r?\n`)

func parseBlock(block string) (Event, bool) {
	var event *string
	var data []string
	for _, line := range lineRe.Split(block, -1) {
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		idx := strings.Index(line, ":")
		field, value := line, ""
		if idx != -1 {
			field, value = line[:idx], line[idx+1:]
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			v := value
			event = &v
		case "data":
			data = append(data, value)
		}
	}
	if len(data) == 0 && (event == nil || *event == "") { // JS `!event`
		return Event{}, false
	}
	return Event{Event: event, Data: strings.Join(data, "\n")}, true
}

// Format is formatSse; event "" means no event line (TS `undefined`).
func Format(event string, data any) string {
	payload, ok := data.(string)
	if !ok {
		payload = u.Stringify(data)
	}
	if event != "" {
		return "event: " + event + "\ndata: " + payload + "\n\n"
	}
	return "data: " + payload + "\n\n"
}
