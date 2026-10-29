package server

import (
	"io"
	"net/http"
	"strings"
	"sync"
)

// Chunks is a ReadableStream reader: Next yields one enqueued chunk (an empty
// non-nil chunk is a real empty enqueue), io.EOF at the end. Close cancels.
type Chunks interface {
	Next() ([]byte, error)
	Close() error
}

// Resp is a fetch Response: status, statusText, headers, body (nil = null).
type Resp struct {
	Status     int
	StatusText string
	Header     http.Header
	Body       Chunks
}

type readerChunks struct {
	r   io.ReadCloser
	buf []byte
}

func (c *readerChunks) Next() ([]byte, error) {
	if c.buf == nil {
		c.buf = make([]byte, 64*1024)
	}
	for {
		n, err := c.r.Read(c.buf)
		if n > 0 {
			out := append([]byte(nil), c.buf[:n]...)
			return out, nil // a trailing err is returned by the next Read again (EOF) or surfaced next
		}
		if err != nil {
			return nil, err
		}
	}
}
func (c *readerChunks) Close() error { return c.r.Close() }

// ChunksOf adapts a body: chunk-aware bodies (StagedBody) pass through.
func ChunksOf(r io.ReadCloser) Chunks {
	if r == nil || r == http.NoBody {
		return nil
	}
	if c, ok := r.(Chunks); ok {
		return c
	}
	return &readerChunks{r: r}
}

// RespOf wraps an *http.Response.
func RespOf(r *http.Response) *Resp {
	st := r.Status
	if len(st) > 4 && st[3] == ' ' {
		st = st[4:]
	}
	body := ChunksOf(r.Body)
	// fetch: Response.body is null only for null-body statuses and HEAD; an
	// empty (Content-Length: 0) body is still a stream that ends at once.
	if body == nil && !nullBodyStatus(r.StatusCode) && (r.Request == nil || r.Request.Method != http.MethodHead) {
		body = &readerChunks{r: io.NopCloser(strings.NewReader(""))}
	}
	return &Resp{Status: r.StatusCode, StatusText: st, Header: r.Header, Body: body}
}

func nullBodyStatus(s int) bool { return s == 101 || s == 103 || s == 204 || s == 205 || s == 304 }

// bodyReader adapts Chunks to io.ReadCloser (for StagedResponse etc.).
type bodyReader struct {
	c  Chunks
	rd []byte
}

func (b *bodyReader) Read(p []byte) (int, error) {
	for len(b.rd) == 0 {
		c, err := b.c.Next()
		if err != nil {
			return 0, err
		}
		b.rd = c
	}
	n := copy(p, b.rd)
	b.rd = b.rd[n:]
	return n, nil
}
func (b *bodyReader) Close() error { return b.c.Close() }

// ReaderOf adapts Chunks back to an io.ReadCloser that still exposes Next.
func ReaderOf(c Chunks) io.ReadCloser {
	if rc, ok := c.(io.ReadCloser); ok {
		return rc
	}
	return &chunkRC{bodyReader{c: c}}
}

type chunkRC struct{ bodyReader }

func (c *chunkRC) Next() ([]byte, error) {
	if len(c.rd) > 0 {
		out := c.rd
		c.rd = nil
		return out, nil
	}
	return c.c.Next()
}

type readResult struct {
	b   []byte
	err error
}

// asyncReader allows one in-flight read awaited with a timeout (a pending
// read survives the race, like a held Promise).
type asyncReader struct {
	c        Chunks
	mu       sync.Mutex
	inflight chan readResult
}

func (a *asyncReader) read() <-chan readResult {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.inflight == nil {
		ch := make(chan readResult, 1)
		a.inflight = ch
		go func() {
			b, err := a.c.Next()
			ch <- readResult{b, err}
		}()
	}
	return a.inflight
}

// take consumes the in-flight result (after it was received from read()).
func (a *asyncReader) take() {
	a.mu.Lock()
	a.inflight = nil
	a.mu.Unlock()
}

// replayChunks is replay(): head chunks first, then the pending read, then the rest.
type replayChunks struct {
	head    [][]byte
	pending <-chan readResult
	src     Chunks
}

func (r *replayChunks) Next() ([]byte, error) {
	if len(r.head) > 0 {
		h := r.head[0]
		r.head = r.head[1:]
		return h, nil
	}
	if p := r.pending; p != nil {
		r.pending = nil
		res := <-p
		return res.b, res.err
	}
	return r.src.Next()
}
func (r *replayChunks) Close() error { return r.src.Close() }
