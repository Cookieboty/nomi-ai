package mockllm

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// Step is one scripted upstream response (mirrors scripts/parity/e2e.mjs).
// When OK is set the response is SSE or JSON from the fixtures, chosen by
// whether the request asked for a stream.
type Step struct {
	OK      string            `json:"ok,omitempty"`
	SSE     string            `json:"sse,omitempty"`
	JSON    string            `json:"json,omitempty"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// Seen is one request the scripted upstream received.
type Seen struct {
	Method  string
	URL     string
	Headers map[string]string
	Body    string
}

// Scripted is a mock upstream replaying a script of responses in order
// (the last step repeats once the script runs out).
type Scripted struct {
	HostPort string
	keep     []string
	mu       sync.Mutex
	script   []Step
	seen     []Seen
	srv      *http.Server
}

// StartScripted starts the scripted upstream; keep lists the request headers to record.
func StartScripted(keep []string) (*Scripted, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &Scripted{HostPort: ln.Addr().String(), keep: keep}
	s.srv = &http.Server{Handler: http.HandlerFunc(s.serve)}
	go s.srv.Serve(ln)
	return s, nil
}

// Set replaces the script and clears the recorded requests.
func (s *Scripted) Set(script []Step) {
	s.mu.Lock()
	s.script, s.seen = script, nil
	s.mu.Unlock()
}

// Seen returns the requests received since the last Set.
func (s *Scripted) Seen() []Seen {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Seen(nil), s.seen...)
}

// Close stops the server.
func (s *Scripted) Close() { s.srv.Close() }

func (s *Scripted) serve(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	h := map[string]string{}
	for _, k := range s.keep {
		if vs := r.Header.Values(k); len(vs) > 0 {
			h[k] = strings.Join(vs, ", ")
		}
	}
	s.mu.Lock()
	s.seen = append(s.seen, Seen{Method: r.Method, URL: r.URL.RequestURI(), Headers: h, Body: string(b)})
	n := len(s.seen)
	var step Step
	if len(s.script) == 0 {
		step = Step{Status: 599, Body: "unscripted"}
	} else {
		step = s.script[min(n-1, len(s.script)-1)]
	}
	s.mu.Unlock()
	if step.OK != "" {
		stream := strings.Contains(r.URL.RequestURI(), "streamGenerateContent")
		var probe struct {
			Stream any `json:"stream"`
		}
		if json.Unmarshal(b, &probe) == nil && probe.Stream == true {
			stream = true
		}
		if stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			io.WriteString(w, step.SSE)
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			io.WriteString(w, step.JSON)
		}
		return
	}
	for k, v := range step.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(step.Status)
	io.WriteString(w, step.Body)
}
