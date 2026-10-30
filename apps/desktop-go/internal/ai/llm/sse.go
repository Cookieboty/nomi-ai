package llm

import (
	"strings"
)

// EventSourceMessage is eventsource-parser's EventSourceMessage.
type EventSourceMessage struct {
	ID    *string
	Event *string
	Data  string
}

// SSEParser is eventsource-parser 3.1.1 createParser (+ EventSourceParserStream:
// errors ignored, the incomplete trailing event is dropped at end of stream).
type SSEParser struct {
	OnEvent func(EventSourceMessage)
	pending strings.Builder
	first   bool
	started bool
	id      *string
	data    string
	lines   int
	event   *string
}

func (p *SSEParser) Feed(chunk string) {
	if !p.started {
		p.started = true
		chunk = strings.TrimPrefix(chunk, "\uFEFF")
	}
	if p.pending.Len() > 0 {
		if !strings.ContainsAny(chunk, "\r\n") {
			p.pending.WriteString(chunk)
			return
		}
		p.pending.WriteString(chunk)
		chunk = p.pending.String()
		p.pending.Reset()
	}
	i := 0
	for i < len(chunk) {
		cr := strings.IndexByte(chunk[i:], '\r')
		lf := strings.IndexByte(chunk[i:], '\n')
		end := -1
		switch {
		case cr != -1 && lf != -1:
			end = min(cr, lf)
		case cr != -1:
			if i+cr != len(chunk)-1 {
				end = cr
			}
		case lf != -1:
			end = lf
		}
		if end == -1 {
			break
		}
		p.line(chunk[i : i+end])
		i += end + 1
		if chunk[i-1] == '\r' && i < len(chunk) && chunk[i] == '\n' {
			i++
		}
	}
	if i < len(chunk) {
		p.pending.WriteString(chunk[i:])
	}
}

func (p *SSEParser) line(l string) {
	if l == "" {
		if p.lines > 0 && p.OnEvent != nil {
			p.OnEvent(EventSourceMessage{ID: p.id, Event: p.event, Data: p.data})
		}
		p.id, p.data, p.lines, p.event = nil, "", 0, nil
		return
	}
	if l[0] == ':' {
		return
	}
	field, value := l, ""
	if k := strings.IndexByte(l, ':'); k >= 0 {
		field = l[:k]
		value = l[k+1:]
		value = strings.TrimPrefix(value, " ")
	}
	switch field {
	case "event":
		if value == "" {
			p.event = nil
		} else {
			v := value
			p.event = &v
		}
	case "data":
		if p.lines == 0 {
			p.data = value
		} else {
			p.data += "\n" + value
		}
		p.lines++
	case "id":
		if !strings.Contains(value, "\x00") {
			v := value
			p.id = &v
		}
	}
}
