package mcp

import (
	"bufio"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// sseEvent = eventsource-parser 3.1.1 EventSourceMessage
type sseEvent struct {
	ID       string
	HasID    bool
	Event    string
	HasEvent bool
	Data     string
}

// sseParser = createParser（无 maxBufferSize；未知字段/非法 retry 的 onError 在 stream 里为 no-op）。
type sseParser struct {
	first     bool
	pending   string
	id        string
	hasID     bool
	data      string
	dataLines int
	ev        string
	hasEv     bool
	onEvent   func(sseEvent)
}

func newSSEParser(on func(sseEvent)) *sseParser { return &sseParser{first: true, onEvent: on} }

func (p *sseParser) feed(chunk string) {
	if p.first {
		p.first = false
		// chunk.charCodeAt(0..2) === 239,187,191：比较的是已解码字符 U+00EF U+00BB U+00BF
		if strings.HasPrefix(chunk, "\u00EF\u00BB\u00BF") {
			chunk = chunk[len("\u00EF\u00BB\u00BF"):]
		}
	}
	if p.pending != "" {
		chunk = p.pending + chunk
		p.pending = ""
	}
	p.pending = p.processLines(chunk)
}

func (p *sseParser) processLines(chunk string) string {
	i := 0
	for i < len(chunk) {
		cr := strings.IndexByte(chunk[i:], '\r')
		lf := strings.IndexByte(chunk[i:], '\n')
		end := -1
		switch {
		case cr >= 0 && lf >= 0:
			end = min(cr, lf)
		case cr >= 0:
			if i+cr != len(chunk)-1 {
				end = cr
			}
		case lf >= 0:
			end = lf
		}
		if end < 0 {
			break
		}
		end += i
		p.parseLine(chunk[i:end])
		i = end + 1
		if chunk[i-1] == '\r' && i < len(chunk) && chunk[i] == '\n' {
			i++
		}
	}
	return chunk[i:]
}

func (p *sseParser) dispatch() {
	if p.dataLines > 0 {
		p.onEvent(sseEvent{ID: p.id, HasID: p.hasID, Event: p.ev, HasEvent: p.hasEv, Data: p.data})
	}
	p.id, p.hasID, p.data, p.dataLines, p.ev, p.hasEv = "", false, "", 0, "", false
}

func (p *sseParser) parseLine(line string) {
	if line == "" {
		p.dispatch()
		return
	}
	if line[0] == ':' {
		return
	}
	field, value := line, ""
	if j := strings.IndexByte(line, ':'); j >= 0 {
		field = line[:j]
		off := 1
		if j+1 < len(line) && line[j+1] == ' ' {
			off = 2
		}
		if j+off <= len(line) {
			value = line[j+off:]
		}
	}
	switch field {
	case "event":
		p.ev, p.hasEv = value, value != ""
	case "data":
		if p.dataLines == 0 {
			p.data = value
		} else {
			p.data += "\n" + value
		}
		p.dataLines++
	case "id":
		if !strings.Contains(value, "\x00") {
			p.id, p.hasID = value, true
		}
	}
}

// textDecoderStream：TextDecoderStream('utf-8')——跨块保留不完整序列，开头去 BOM。
type textDecoderStream struct {
	rest  []byte
	first bool
}

func (d *textDecoderStream) decode(b []byte) string {
	b = append(d.rest, b...)
	d.rest = nil
	cut := len(b)
	for k := 1; k <= 3 && k <= len(b); k++ { // 末尾不完整 UTF-8 序列留到下一块
		c := b[len(b)-k]
		if c&0xC0 == 0x80 {
			continue
		}
		if c >= 0xC0 {
			need := 2
			if c >= 0xF0 {
				need = 4
			} else if c >= 0xE0 {
				need = 3
			}
			if k < need && utf8.FullRune(b[len(b)-k:]) == false {
				cut = len(b) - k
			}
		}
		break
	}
	d.rest = append([]byte(nil), b[cut:]...)
	s := nodeproc.DecodeChunk(b[:cut])
	if !d.first {
		d.first = true
		s = strings.TrimPrefix(s, "\uFEFF")
	}
	return s
}

// readSSE：body → TextDecoderStream → EventSourceParserStream；每个事件回调 on（返回 false 停止）。
// 返回 nil = 流结束（done），否则为读错误。
func readSSE(body io.Reader, on func(sseEvent) bool) error {
	var events []sseEvent
	p := newSSEParser(func(e sseEvent) { events = append(events, e) })
	d := &textDecoderStream{}
	br := bufio.NewReaderSize(body, 32*1024)
	buf := make([]byte, 32*1024)
	for {
		n, err := br.Read(buf)
		if n > 0 {
			p.feed(d.decode(buf[:n]))
			for len(events) > 0 {
				e := events[0]
				events = events[1:]
				if !on(e) {
					return nil
				}
			}
		}
		if err == io.EOF {
			if len(d.rest) > 0 { // flush：残缺序列 → U+FFFD
				p.feed(nodeproc.DecodeChunk(d.rest))
				d.rest = nil
				for _, e := range events {
					if !on(e) {
						return nil
					}
				}
			}
			return nil
		}
		if err != nil {
			return err
		}
	}
}
