package providers

import (
	"io"
	"net/http"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// StagedBody is the TransformStream of stagedResponse: Next yields each
// enqueued chunk; an empty non-nil chunk is the keepalive-only enqueue that
// lets readers see stage.alive in time.
type StagedBody struct {
	src   io.ReadCloser
	stage *Stage
	onRaw func(string)
	dec   u.TextDecoder
	buf   []byte
	err   error // deferred source error/EOF
	done  bool
	rd    []byte // unread remainder for Read
}

func (s *StagedBody) emit(text string) []byte {
	if text != "" {
		return []byte(text)
	}
	if s.stage.Alive != 0 {
		return []byte{}
	}
	return nil
}

// Next returns the next chunk, or (nil, io.EOF) / (nil, upstream error).
func (s *StagedBody) Next() ([]byte, error) {
	if s.buf == nil {
		s.buf = make([]byte, 32*1024)
	}
	for {
		if s.done {
			if s.err != nil && s.err != io.EOF {
				return nil, s.err
			}
			return nil, io.EOF
		}
		if s.err != nil {
			s.done = true
			if s.err != io.EOF { // errored stream: no flush
				continue
			}
			t := s.dec.Flush()
			if t != "" && s.onRaw != nil {
				s.onRaw(t)
			}
			if out := s.emit(s.stage.Push(t) + s.stage.End()); out != nil {
				return out, nil
			}
			continue
		}
		n, err := s.src.Read(s.buf)
		s.err = err
		if n > 0 {
			t := s.dec.Decode(s.buf[:n])
			if s.onRaw != nil {
				s.onRaw(t)
			}
			if out := s.emit(s.stage.Push(t)); out != nil {
				return out, nil
			}
		}
	}
}

// Read adapts Next to io.Reader (empty chunks are invisible here).
func (s *StagedBody) Read(p []byte) (int, error) {
	for len(s.rd) == 0 {
		c, err := s.Next()
		if err != nil {
			return 0, err
		}
		s.rd = c
	}
	n := copy(p, s.rd)
	s.rd = s.rd[n:]
	return n, nil
}

// Close closes the upstream body.
func (s *StagedBody) Close() error { return s.src.Close() }

// StagedResponse is stagedResponse(up, stage, onRaw): same status and headers,
// body run through the provider stage.
func StagedResponse(up *http.Response, stage *Stage, onRaw func(string)) *http.Response {
	if up.Body == nil || up.Body == http.NoBody {
		return up
	}
	r := *up
	r.Body = &StagedBody{src: up.Body, stage: stage, onRaw: onRaw}
	return &r
}
