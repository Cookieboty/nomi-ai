// Package llmtest replays golden Node AI-SDK provider recordings against the Go adapters.
package llmtest

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type Step struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body"`
	Chunks  []string          `json:"chunks"`
	End     string            `json:"end"`
}

type Call struct {
	Kind            string          `json:"kind"`
	Options         json.RawMessage `json:"options"`
	RequestBody     json.RawMessage `json:"requestBody"`
	ResponseHeaders json.RawMessage `json:"responseHeaders"`
	Parts           json.RawMessage `json:"parts"`
	Result          json.RawMessage `json:"result"`
	Thrown          json.RawMessage `json:"thrown"`
	StreamError     json.RawMessage `json:"streamError"`
	Request         *struct {
		Method  string            `json:"method"`
		Path    string            `json:"path"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	} `json:"request"`
}

type Scenario struct {
	Name                string          `json:"name"`
	Protocol            string          `json:"protocol"`
	Settings            json.RawMessage `json:"settings"`
	Responses           []Step          `json:"responses"`
	AbortAfterParts     int             `json:"abortAfterParts"`
	AbortBeforeGenerate bool            `json:"abortBeforeGenerate"`
	Calls               []Call          `json:"calls"`
}

type Settings struct {
	ID, Protocol, BaseURL, APIKey string
	Headers                       map[string]string
	UserAgent                     string
	DefaultModel                  string
}

func Load(t *testing.T, path, protocol string) []Scenario {
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Node      string
		Scenarios []Scenario
	}
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	// The UA runtime suffix is the recording Node's major (D-B5-P-3).
	if m := strings.SplitN(strings.TrimPrefix(g.Node, "v"), ".", 2); m[0] != "" {
		prev := llm.RuntimeUserAgent
		llm.RuntimeUserAgent = "node.js/" + m[0]
		t.Cleanup(func() { llm.RuntimeUserAgent = prev })
	}
	var out []Scenario
	for _, s := range g.Scenarios {
		if s.Protocol == protocol {
			out = append(out, s)
		}
	}
	return out
}

var transport = map[string]bool{"host": true, "connection": true, "content-length": true, "accept": true,
	"accept-language": true, "sec-fetch-mode": true, "accept-encoding": true, "transfer-encoding": true,
	"keep-alive": true, "date": true}

type seenReq struct {
	Method, Path, Body string
	Headers            map[string]string
}

// Server scripts responses like the Node recorder.
type Server struct {
	*httptest.Server
	mu    sync.Mutex
	queue []Step
	Seen  []seenReq
}

func NewServer(steps []Step) *Server {
	s := &Server{queue: append([]Step(nil), steps...)}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h := map[string]string{}
		for k, v := range r.Header {
			k = strings.ToLower(k)
			if !transport[k] {
				h[k] = strings.Join(v, ", ")
			}
		}
		s.mu.Lock()
		s.Seen = append(s.Seen, seenReq{r.Method, r.URL.RequestURI(), string(b), h})
		var st Step
		if len(s.queue) > 0 {
			st, s.queue = s.queue[0], s.queue[1:]
		} else {
			body := "no scripted step"
			st = Step{Status: 500, Body: &body}
		}
		s.mu.Unlock()
		for k, v := range st.Headers {
			w.Header().Set(k, v)
		}
		if st.Status == 0 {
			st.Status = 200
		}
		w.WriteHeader(st.Status)
		chunks := st.Chunks
		if chunks == nil && st.Body != nil {
			chunks = []string{*st.Body}
		}
		f, _ := w.(http.Flusher)
		for _, c := range chunks {
			io.WriteString(w, c)
			if f != nil {
				f.Flush()
			}
			time.Sleep(2 * time.Millisecond)
		}
		switch st.End {
		case "destroy":
			if hj, ok := w.(http.Hijacker); ok {
				c, _, _ := hj.Hijack()
				c.Close()
			}
		case "hang":
			<-r.Context().Done()
		}
	}))
	return s
}

var portRe = regexp.MustCompile(`http://127\.0\.0\.1:\d+`)

// Rebase rewrites the recorder's base URL into this server's.
func (s *Server) Rebase(u string) string { return portRe.ReplaceAllString(u, s.URL) }

// ---------- options ----------

func num(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

func obj(v any) *util.Obj { o, _ := v.(*util.Obj); return o }

func str(v any) string { s, _ := v.(string); return s }

func fileData(v any) llm.FileData {
	switch x := v.(type) {
	case string:
		return llm.FileData{Type: "data", Base64: x, IsString: true}
	case *util.Obj:
		if b, ok := x.Get("__bytes").(string); ok {
			raw, _ := base64.StdEncoding.DecodeString(b)
			return llm.FileData{Type: "data", Bytes: raw}
		}
		if u, ok := x.Get("__url").(string); ok {
			return llm.FileData{Type: "url", URL: u}
		}
		switch x.Get("type") {
		case "data":
			return fileData(x.Get("data"))
		case "url":
			u := x.Get("url")
			if o := obj(u); o != nil {
				u = o.Get("__url")
			}
			return llm.FileData{Type: "url", URL: str(u)}
		case "reference":
			return llm.FileData{Type: "reference", Reference: obj(x.Get("reference"))}
		case "text":
			return llm.FileData{Type: "text", Text: str(x.Get("text"))}
		}
	}
	return llm.FileData{}
}

func part(v any) llm.Part {
	o := obj(v)
	p := llm.Part{Type: str(o.Get("type")), Text: str(o.Get("text")), Filename: str(o.Get("filename")),
		MediaType: str(o.Get("mediaType")), ToolCallID: str(o.Get("toolCallId")), ToolName: str(o.Get("toolName")),
		Input: o.Get("input"), ProviderOptions: obj(o.Get("providerOptions"))}
	if o.Has("data") {
		p.Data = fileData(o.Get("data"))
	}
	if out := obj(o.Get("output")); out != nil {
		r := &llm.ToolResultOutput{Type: str(out.Get("type")), Value: out.Get("value"), ProviderOptions: obj(out.Get("providerOptions"))}
		if s, ok := out.Get("reason").(string); ok {
			r.Reason = &s
		}
		if r.Type == "content" {
			for _, x := range anyArr(out.Get("value")) {
				r.Content = append(r.Content, part(x))
			}
		}
		p.Output = r
	}
	return p
}

// Options converts a recorded LanguageModelV4CallOptions JSON.
func Options(raw json.RawMessage) llm.CallOptions {
	v, err := util.ParseString(string(raw))
	if err != nil {
		panic(err)
	}
	o := v.(*util.Obj)
	c := llm.CallOptions{MaxOutputTokens: num(o.Get("maxOutputTokens")), Temperature: num(o.Get("temperature")),
		TopP: num(o.Get("topP")), TopK: num(o.Get("topK")), PresencePenalty: num(o.Get("presencePenalty")),
		FrequencyPenalty: num(o.Get("frequencyPenalty")), Seed: num(o.Get("seed")),
		IncludeRawChunks: o.Get("includeRawChunks") == true, Reasoning: str(o.Get("reasoning")),
		ProviderOptions: obj(o.Get("providerOptions"))}
	for _, s := range anyArr(o.Get("stopSequences")) {
		c.StopSequences = append(c.StopSequences, str(s))
	}
	if rf := obj(o.Get("responseFormat")); rf != nil {
		c.ResponseFormat = &llm.ResponseFormat{Type: str(rf.Get("type")), Schema: rf.Get("schema"), Name: str(rf.Get("name")), Description: str(rf.Get("description"))}
	}
	for _, t := range anyArr(o.Get("tools")) {
		to := obj(t)
		tl := llm.Tool{Type: str(to.Get("type")), Name: str(to.Get("name")), InputSchema: to.Get("inputSchema"),
			ID: str(to.Get("id")), Args: obj(to.Get("args")), ProviderOptions: obj(to.Get("providerOptions"))}
		if s, ok := to.Get("description").(string); ok {
			tl.Description = &s
		}
		if b, ok := to.Get("strict").(bool); ok {
			tl.Strict = &b
		}
		c.Tools = append(c.Tools, tl)
	}
	if tc := obj(o.Get("toolChoice")); tc != nil {
		c.ToolChoice = &llm.ToolChoice{Type: str(tc.Get("type")), ToolName: str(tc.Get("toolName"))}
	}
	for _, h := range anyArr(o.Get("headers")) {
		kv := anyArr(h)
		if kv[1] == nil {
			c.Headers = append(c.Headers, llm.Header{Name: str(kv[0]), Undefined: true})
		} else {
			c.Headers = append(c.Headers, llm.H(str(kv[0]), str(kv[1])))
		}
	}
	for _, m := range anyArr(o.Get("prompt")) {
		mo := obj(m)
		msg := llm.Message{Role: str(mo.Get("role")), ProviderOptions: obj(mo.Get("providerOptions"))}
		if s, ok := mo.Get("content").(string); ok {
			msg.Text = s
		} else {
			for _, p := range anyArr(mo.Get("content")) {
				msg.Parts = append(msg.Parts, part(p))
			}
		}
		c.Prompt = append(c.Prompt, msg)
	}
	return c
}

func anyArr(v any) []any { a, _ := v.([]any); return a }

// ---------- serialization (mirrors the recorder's plain()/errJSON) ----------

func setNum(o *util.Obj, k string, v *float64) {
	if v != nil {
		o.Set(k, *v)
	}
}

func UsageJSON(u llm.Usage) *util.Obj {
	in, out := util.NewObj(), util.NewObj()
	setNum(in, "total", u.InputTotal)
	setNum(in, "noCache", u.InputNoCache)
	setNum(in, "cacheRead", u.InputCacheRead)
	setNum(in, "cacheWrite", u.InputCacheWrite)
	setNum(out, "total", u.OutputTotal)
	setNum(out, "text", u.OutputText)
	setNum(out, "reasoning", u.OutputReasoning)
	o := util.NewObj("inputTokens", in, "outputTokens", out)
	if u.Raw != nil {
		o.Set("raw", u.Raw)
	}
	return o
}

func FinishJSON(f llm.FinishReason) *util.Obj {
	o := util.NewObj("unified", f.Unified)
	if f.Raw != nil {
		o.Set("raw", *f.Raw)
	}
	return o
}

func WarningsJSON(ws []llm.Warning) []any {
	out := []any{}
	for _, w := range ws {
		o := util.NewObj("type", w.Type)
		if w.Feature != "" {
			o.Set("feature", w.Feature)
		}
		if w.Setting != "" {
			o.Set("setting", w.Setting)
		}
		if w.Details != nil {
			o.Set("details", *w.Details)
		}
		if w.Message != "" {
			o.Set("message", w.Message)
		}
		out = append(out, o)
	}
	return out
}

func MetaInto(o *util.Obj, m llm.ResponseMetadata) {
	if m.ID != nil {
		o.Set("id", *m.ID)
	}
	if m.Timestamp != nil {
		o.Set("timestamp", util.NewObj("__date", *m.Timestamp))
	}
	if m.ModelID != nil {
		o.Set("modelId", *m.ModelID)
	}
}

func ErrJSON(err error) any {
	o := llm.ErrorJSON(err)
	if o != nil {
		o.Delete("cause")
		if h, ok := o.Get("responseHeaders").(*util.Obj); ok {
			for _, k := range h.Keys() {
				if transport[k] {
					h.Delete(k)
				}
			}
		}
	}
	return o
}

func PartJSON(p llm.StreamPart) *util.Obj {
	o := util.NewObj("type", p.Type)
	switch p.Type {
	case "stream-start":
		o.Set("warnings", WarningsJSON(p.Warnings))
	case "response-metadata":
		MetaInto(o, *p.Meta)
	case "text-start", "text-end", "reasoning-start", "reasoning-end", "tool-input-end":
		o.Set("id", p.ID)
	case "text-delta", "reasoning-delta", "tool-input-delta":
		o.Set("id", p.ID).Set("delta", p.Delta)
	case "tool-input-start":
		o.Set("id", p.ID).Set("toolName", p.ToolName)
	case "text", "reasoning":
		o.Set("text", p.Text)
	case "tool-call":
		o.Set("toolCallId", p.ToolCallID).Set("toolName", p.ToolName).Set("input", p.Input)
	case "error":
		if p.Err != nil {
			o.Set("error", ErrJSON(p.Err))
		} else {
			o.Set("error", p.RawValue)
		}
	case "raw":
		o.Set("rawValue", p.RawValue)
	case "source":
		o.Set("sourceType", p.SourceType).Set("id", p.ID)
		if p.SourceType == "url" {
			o.Set("url", p.URL)
		} else {
			o.Set("mediaType", p.MediaType)
		}
		if p.Title != nil {
			o.Set("title", *p.Title)
		}
		if p.Filename != nil {
			o.Set("filename", *p.Filename)
		}
	case "finish":
		o.Set("finishReason", FinishJSON(*p.FinishReason)).Set("usage", UsageJSON(*p.Usage))
	}
	if p.ProviderMetadata != nil {
		o.Set("providerMetadata", p.ProviderMetadata)
	}
	return o
}

// Canon parses JSON text into a comparable value (key order ignored).
func Canon(v any) any {
	var b []byte
	switch x := v.(type) {
	case json.RawMessage:
		b = x
	case string:
		b = []byte(x)
	default:
		b = []byte(util.Stringify(v))
	}
	var out any
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, &out); err != nil {
		panic(fmt.Sprintf("canon %q: %v", b, err))
	}
	return out
}

type Diff struct {
	t      *testing.T
	Errors []string
}

func (d *Diff) Eq(what string, want, got any) {
	w, g := Canon(want), Canon(got)
	if !reflect.DeepEqual(w, g) {
		wb, _ := json.Marshal(w)
		gb, _ := json.Marshal(g)
		d.Errors = append(d.Errors, fmt.Sprintf("%s mismatch\n want %s\n  got %s", what, wb, gb))
	}
}

// ---------- replay ----------

// Factory builds the model for a scenario's settings against base URL.
type Factory func(s Settings, baseURL string, genID func() string) llm.LanguageModel

// idMapper normalizes generated ids: map golden ids to Go ids by order.
type Run struct {
	Scenario Scenario
	Server   *Server
}

func ParseSettings(raw json.RawMessage) Settings {
	var s struct {
		ID, Protocol, BaseURL, APIKey, UserAgent, DefaultModel string
		Headers                                                map[string]string
	}
	json.Unmarshal(raw, &s)
	return Settings{ID: s.ID, Protocol: s.Protocol, BaseURL: s.BaseURL, APIKey: s.APIKey, Headers: s.Headers, UserAgent: s.UserAgent, DefaultModel: s.DefaultModel}
}

// Replay runs every recorded call (one HTTP request each) and compares.
func Replay(t *testing.T, sc Scenario, f Factory, ids []string) []string {
	srv := NewServer(sc.Responses)
	defer srv.Close()
	st := ParseSettings(sc.Settings)
	base := srv.Rebase(st.BaseURL)
	i := 0
	genID := func() string {
		if i < len(ids) {
			i++
			return ids[i-1]
		}
		i++
		return fmt.Sprintf("gen-%d", i)
	}
	m := f(st, base, genID)
	d := &Diff{t: t}
	for ci, c := range sc.Calls {
		tag := fmt.Sprintf("call[%d]", ci)
		opts := Options(c.Options)
		ctx, cancel := context.WithCancel(context.Background())
		if sc.AbortBeforeGenerate {
			time.AfterFunc(50*time.Millisecond, cancel)
		}
		var thrown error
		if c.Kind == "stream" {
			res, err := m.DoStream(ctx, opts)
			if err != nil {
				thrown = err
			} else {
				d.Eq(tag+".requestBody", c.RequestBody, res.RequestBody)
				d.Eq(tag+".responseHeaders", c.ResponseHeaders, filterHeaders(res.ResponseHeaders))
				parts := []any{}
				var streamErr error
				for p := range res.Stream {
					if p.Type == llm.PartStreamError {
						streamErr = p.Err
						continue
					}
					parts = append(parts, PartJSON(p))
					if sc.AbortAfterParts > 0 && len(parts) == sc.AbortAfterParts {
						cancel()
					}
				}
				d.Eq(tag+".parts", rebaseJSON(srv, c.Parts), parts)
				if c.StreamError != nil || streamErr != nil {
					d.Eq(tag+".streamError", rebaseJSON(srv, c.StreamError), ErrJSON(streamErr))
				}
			}
		} else {
			res, err := m.DoGenerate(ctx, opts)
			if err != nil {
				thrown = err
			} else {
				content := []any{}
				for _, p := range res.Content {
					content = append(content, PartJSON(p))
				}
				resp := util.NewObj()
				MetaInto(resp, res.Response)
				resp.Set("headers", filterHeaders(res.ResponseHeaders)).Set("body", res.ResponseBody)
				r := util.NewObj("content", content, "finishReason", FinishJSON(res.FinishReason),
					"usage", UsageJSON(res.Usage), "warnings", WarningsJSON(res.Warnings),
					"requestBody", requestBodyAs(c.Result, res.RequestBody), "response", resp)
				if res.ProviderMetadata != nil {
					r.Set("providerMetadata", res.ProviderMetadata)
				}
				d.Eq(tag+".result", c.Result, r)
			}
		}
		cancel()
		if c.Thrown != nil || thrown != nil {
			d.Eq(tag+".thrown", rebaseJSON(srv, c.Thrown), ErrJSON(thrown))
		}
	}
	time.Sleep(20 * time.Millisecond)
	srv.mu.Lock()
	seen := srv.Seen
	srv.mu.Unlock()
	// Calls that threw before fetch (no recorded request) send nothing.
	want := 0
	for _, c := range sc.Calls {
		if c.Request != nil {
			want++
		}
	}
	if len(seen) != want {
		d.Errors = append(d.Errors, fmt.Sprintf("requests: want %d got %d", want, len(seen)))
	}
	for ci, c := range sc.Calls {
		if c.Request == nil || ci >= len(seen) {
			continue
		}
		g := seen[ci]
		tag := fmt.Sprintf("call[%d].request", ci)
		if c.Request.Method != g.Method || c.Request.Path != g.Path {
			d.Errors = append(d.Errors, fmt.Sprintf("%s line: want %s %s got %s %s", tag, c.Request.Method, c.Request.Path, g.Method, g.Path))
		}
		if c.Request.Body != g.Body {
			d.Errors = append(d.Errors, fmt.Sprintf("%s body:\n want %s\n  got %s", tag, c.Request.Body, g.Body))
		}
		d.Eq(tag+".headers", toJSON(c.Request.Headers), toJSON(g.Headers))
	}
	return d.Errors
}

// requestBodyAs matches the recorded request.body shape: providers that
// return the JSON text (openai-compatible) vs the args object (openai responses).
func requestBodyAs(result json.RawMessage, got string) any {
	var r struct{ RequestBody json.RawMessage }
	if json.Unmarshal(result, &r) == nil && len(r.RequestBody) > 0 && r.RequestBody[0] == '{' {
		var v any
		if json.Unmarshal([]byte(got), &v) == nil {
			return v
		}
	}
	return got
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func rebaseJSON(s *Server, raw json.RawMessage) any {
	if raw == nil {
		return nil
	}
	return s.Rebase(string(raw))
}

func filterHeaders(h map[string]string) *util.Obj {
	ks := make([]string, 0, len(h))
	for k := range h {
		if !transport[k] {
			ks = append(ks, k)
		}
	}
	sort.Strings(ks)
	o := util.NewObj()
	for _, k := range ks {
		o.Set(k, h[k])
	}
	return o
}

// GoldenIDs collects generated-id-looking ids (16 chars, alnum) in order of first appearance.
var idRe = regexp.MustCompile(`"(?:id|toolCallId)":\s*"([0-9A-Za-z]{16})"`)

func GoldenIDs(sc Scenario) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range sc.Calls {
		for _, raw := range []json.RawMessage{c.Parts, c.Result} {
			for _, m := range idRe.FindAllStringSubmatch(string(raw), -1) {
				if !seen[m[1]] {
					seen[m[1]] = true
					out = append(out, m[1])
				}
			}
		}
	}
	return out
}
