package aisdk

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Golden replay of scripts/parity/record-b5-aisdk.mjs (Node AiSdkLlmProvider + ai streamText /
// generateText with a scripted LanguageModelV4). Model call options, ChatChunks / ChatResponse,
// thrown errors and tool executions must match byte for byte.

type scenario struct {
	Name    string          `json:"name"`
	Mode    string          `json:"mode"`
	Opts    json.RawMessage `json:"opts"`
	Request json.RawMessage `json:"request"`
	Steps   []json.RawMessage
	Tools   []json.RawMessage `json:"tools"`
}

type record struct {
	Name   string   `json:"name"`
	Calls  []string `json:"calls"`
	Execs  []string `json:"execs"`
	Chunks []string `json:"chunks"`
	Result *string  `json:"result"`
	Error  *string  `json:"error"`
}

func obj(raw json.RawMessage) *u.Obj {
	if len(raw) == 0 || string(raw) == "null" {
		return u.NewObj()
	}
	v, err := u.Parse(raw)
	if err != nil {
		panic(err)
	}
	return v.(*u.Obj)
}

type mockModel struct {
	modelID string
	sc      *scenario
	i       *int
	calls   *[]string
	mu      *sync.Mutex
}

func (m mockModel) Provider() string { return "mock" }
func (m mockModel) ModelID() string  { return m.modelID }

// callJSON：llm.CallOptions → Node 记录的 LanguageModelV4CallOptions JSON（同键序）
func callJSON(o llm.CallOptions, stream bool) *u.Obj {
	r := u.NewObj()
	if o.MaxOutputTokens != nil {
		r.Set("maxOutputTokens", *o.MaxOutputTokens)
	}
	if o.Temperature != nil {
		r.Set("temperature", *o.Temperature)
	}
	if o.TopP != nil {
		r.Set("topP", *o.TopP)
	}
	if o.Tools != nil {
		ts := []any{}
		for _, t := range o.Tools {
			to := u.NewObj("type", t.Type, "name", t.Name, "inputSchema", t.InputSchema)
			if t.Description != nil {
				to.Set("description", *t.Description)
			}
			ts = append(ts, to)
		}
		r.Set("tools", ts)
	}
	if o.ToolChoice != nil {
		r.Set("toolChoice", u.NewObj("type", o.ToolChoice.Type))
	}
	pr := []any{}
	for _, m := range o.Prompt {
		mo := u.NewObj("role", m.Role)
		if m.Role == "system" {
			mo.Set("content", m.Text)
		} else {
			ps := []any{}
			for _, p := range m.Parts {
				ps = append(ps, partJSON(p))
			}
			mo.Set("content", ps)
		}
		if m.ProviderOptions != nil {
			mo.Set("providerOptions", m.ProviderOptions)
		}
		pr = append(pr, mo)
	}
	r.Set("prompt", pr)
	if o.ProviderOptions != nil {
		r.Set("providerOptions", o.ProviderOptions)
	}
	if stream {
		r.Set("includeRawChunks", o.IncludeRawChunks)
	} else {
		h := u.NewObj()
		for _, x := range o.Headers {
			h.Set(x.Name, x.Value)
		}
		r.Set("headers", h)
	}
	return r
}

func partJSON(p llm.Part) *u.Obj {
	o := u.NewObj("type", p.Type)
	switch p.Type {
	case "text", "reasoning":
		o.Set("text", p.Text)
	case "file":
		o.Set("mediaType", p.MediaType)
		if p.Data.IsString {
			o.Set("data", u.NewObj("type", "data", "data", p.Data.Base64))
		} else {
			o.Set("data", u.NewObj("type", p.Data.Type, "url", p.Data.URL))
		}
	case "tool-call":
		o.Set("toolCallId", p.ToolCallID).Set("toolName", p.ToolName).Set("input", p.Input)
		if p.ProviderExec {
			o.Set("providerExecuted", true)
		}
	case "tool-result":
		o.Set("toolCallId", p.ToolCallID).Set("toolName", p.ToolName)
		out := u.NewObj("type", p.Output.Type, "value", p.Output.Value)
		if p.Output.ProviderOptions != nil {
			out.Set("providerOptions", p.Output.ProviderOptions)
		}
		o.Set("output", out)
	}
	if p.ProviderOptions != nil {
		o.Set("providerOptions", p.ProviderOptions)
	}
	return o
}

func (m mockModel) next(opts *u.Obj) (*u.Obj, error) {
	m.mu.Lock()
	rec := u.NewObj("modelId", m.modelID)
	for _, k := range opts.Keys() {
		rec.Set(k, opts.Get(k))
	}
	*m.calls = append(*m.calls, u.Stringify(rec))
	idx := *m.i
	*m.i++
	m.mu.Unlock()
	if idx >= len(m.sc.Steps) {
		return nil, errors.New("script exhausted")
	}
	step := obj(m.sc.Steps[idx])
	if t, ok := step.Get("throw").(*u.Obj); ok {
		msg, _ := t.Get("message").(string)
		if t.Get("plain") == true {
			return nil, errors.New(msg)
		}
		st, _ := t.Get("statusCode").(float64)
		e := llm.APICallError{Message: msg, URL: "http://mock/v1", StatusCode: int(st), ResponseHeaders: headersOf(t), Data: t.Get("data")}
		if d := t.Get("data"); d != nil {
			b := u.Stringify(d)
			e.ResponseBody = &b
		}
		return nil, llm.NewAPICallError(e, nil)
	}
	return step, nil
}

func headersOf(step *u.Obj) map[string]string {
	h, ok := step.Get("headers").(*u.Obj)
	if !ok {
		return nil
	}
	m := map[string]string{}
	for _, k := range h.Keys() {
		m[k] = h.Get(k).(string)
	}
	return m
}

func numOf(o *u.Obj, k string) llm.Num {
	if f, ok := o.Get(k).(float64); ok {
		return &f
	}
	return nil
}

// streamPart：脚本中的 LanguageModelV4StreamPart JSON → llm.StreamPart
func streamPart(po *u.Obj) llm.StreamPart {
	sp := llm.StreamPart{Type: strOf(po.Get("type")), ID: strOf(po.Get("id")), Delta: strOf(po.Get("delta")),
		ToolName: strOf(po.Get("toolName")), ToolCallID: strOf(po.Get("toolCallId")), Input: strOf(po.Get("input"))}
	if b, ok := po.Get("providerExecuted").(bool); ok {
		sp.ProviderExecuted = &b
	}
	if fr := objOf(po.Get("finishReason")); fr != nil {
		f := llm.FinishReason{Unified: strOf(fr.Get("unified"))}
		if r, ok := fr.Get("raw").(string); ok {
			f.Raw = &r
		}
		sp.FinishReason = &f
	}
	if us := objOf(po.Get("usage")); us != nil {
		in, out := objOf(us.Get("inputTokens")), objOf(us.Get("outputTokens"))
		x := llm.Usage{}
		if in != nil {
			x.InputTotal, x.InputNoCache, x.InputCacheRead, x.InputCacheWrite = numOf(in, "total"), numOf(in, "noCache"), numOf(in, "cacheRead"), numOf(in, "cacheWrite")
		}
		if out != nil {
			x.OutputTotal, x.OutputText, x.OutputReasoning = numOf(out, "total"), numOf(out, "text"), numOf(out, "reasoning")
		}
		sp.Usage = &x
	}
	if sp.Type == "error" {
		sp.RawValue = po.Get("error")
	}
	return sp
}

func (m mockModel) DoStream(ctx context.Context, opts llm.CallOptions) (*llm.StreamResult, error) {
	step, err := m.next(callJSON(opts, true))
	if err != nil {
		return nil, err
	}
	ch := make(chan llm.StreamPart)
	go func() {
		defer close(ch)
		for _, p := range step.Get("parts").([]any) {
			select {
			case ch <- streamPart(p.(*u.Obj)):
			case <-ctx.Done():
				return
			}
		}
	}()
	return &llm.StreamResult{Stream: ch, ResponseHeaders: headersOf(step)}, nil
}

func (m mockModel) DoGenerate(ctx context.Context, opts llm.CallOptions) (*llm.GenerateResult, error) {
	step, err := m.next(callJSON(opts, false))
	if err != nil {
		return nil, err
	}
	res := &llm.GenerateResult{ResponseHeaders: headersOf(step)}
	open := map[string]int{}
	for _, p := range step.Get("parts").([]any) {
		po := p.(*u.Obj)
		typ := strOf(po.Get("type"))
		switch typ {
		case "text-start", "reasoning-start":
			open[jsString(po.Get("id"))+typ[:1]] = len(res.Content)
			res.Content = append(res.Content, llm.StreamPart{Type: strings.TrimSuffix(typ, "-start")})
		case "text-delta", "reasoning-delta":
			res.Content[open[jsString(po.Get("id"))+typ[:1]]].Text += strOf(po.Get("delta"))
		case "tool-call":
			res.Content = append(res.Content, streamPart(po))
		case "finish":
			sp := streamPart(po)
			res.FinishReason, res.Usage = *sp.FinishReason, *sp.Usage
		}
	}
	return res, nil
}

func optsOf(o *u.Obj) Options {
	op := Options{ID: "prov", BaseURL: "http://mock/v1", APIKey: "sk-test", DefaultModel: "default-model"}
	if s, ok := o.Get("protocol").(string); ok {
		op.Protocol = s
	}
	if o.Has("apiKey") {
		op.APIKey, _ = o.Get("apiKey").(string)
	}
	if b, ok := o.Get("requiresApiKey").(bool); ok {
		op.RequiresAPIKey = &b
	}
	if s, ok := o.Get("defaultModel").(string); ok {
		op.DefaultModel = s
	}
	if l, ok := o.Get("modelMap").([]any); ok {
		op.ModelMap = l
	}
	if b, ok := o.Get("thinking").(bool); ok {
		op.Thinking = &b
	}
	if f, ok := o.Get("maxSteps").(float64); ok {
		n := int(f)
		op.MaxSteps = &n
	}
	op.ServedModelHeader, _ = o.Get("servedModelHeader").(string)
	op.RedactedHeader, _ = o.Get("redactedHeader").(string)
	return op
}

func toolDefs(sc *scenario, p *Provider, reqID string, execs *[]string, mu *sync.Mutex) []tools.Definition {
	var defs []tools.Definition
	for _, raw := range sc.Tools {
		t := obj(raw)
		name := t.Get("name").(string)
		desc, _ := t.Get("description").(string)
		noDesc := !t.Has("description")
		in, _ := t.Get("input").(*u.Obj)
		rw, _ := t.Get("requiresWorkspace").(bool)
		b := t.Get("behavior").(*u.Obj)
		defs = append(defs, tools.Definition{
			Name: name, Description: desc, NoDescription: noDesc, Input: in, RequiresWorkspace: rw,
			Execute: func(ctx context.Context, input any, ec tools.ExecContext) (any, error) {
				c := u.NewObj()
				if ec.ToolCallID != "" {
					c.Set("toolCallId", ec.ToolCallID)
				}
				if ec.Provider != nil {
					pr := u.NewObj("id", ec.Provider.ID)
					if ec.Provider.BaseURL != "" {
						pr.Set("baseURL", ec.Provider.BaseURL)
					}
					c.Set("provider", pr)
				}
				for _, kv := range [][2]string{{"reqId", ec.ReqID}, {"callerTabId", ec.CallerTabID}, {"conversationId", ec.ConversationID}, {"cwd", ec.Cwd}} {
					if kv[1] != "" {
						c.Set(kv[0], kv[1])
					}
				}
				mu.Lock()
				*execs = append(*execs, u.Stringify(u.NewObj("name", name, "input", input, "ctx", c)))
				mu.Unlock()
				if d, ok := b.Get("delayMs").(float64); ok {
					time.Sleep(time.Duration(d) * time.Millisecond)
				}
				switch b.Get("kind") {
				case "echo":
					return input, nil
				case "return":
					return b.Get("value"), nil
				case "undefined":
					return u.JSUndefined{}, nil
				case "throw":
					return nil, errors.New(b.Get("message").(string))
				case "bigstring":
					return strings.Repeat("x", int(b.Get("size").(float64))), nil
				case "wait-abort":
					if strings.HasPrefix(sc.Name, "abort") {
						go func() { time.Sleep(5 * time.Millisecond); p.Abort(reqID) }()
					}
					<-ctx.Done()
					return nil, errors.New("aborted by user")
				}
				return nil, nil
			},
		})
	}
	return defs
}

func requestOf(raw json.RawMessage) *blm.ChatRequest {
	var r struct {
		ReqID       string            `json:"reqId"`
		Model       string            `json:"model"`
		Messages    []blm.ChatMessage `json:"messages"`
		Temperature *float64          `json:"temperature"`
		TopP        *float64          `json:"topP"`
		MaxTokens   *float64          `json:"maxTokens"`
		Extra       map[string]any    `json:"extra"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		panic(err)
	}
	return &blm.ChatRequest{ReqID: r.ReqID, Model: r.Model, Messages: r.Messages, Temperature: r.Temperature, TopP: r.TopP, MaxTokens: r.MaxTokens, Extra: r.Extra}
}

func replay(t *testing.T, sc *scenario) record {
	rec := record{Name: sc.Name, Calls: []string{}, Execs: []string{}, Chunks: []string{}}
	var mu sync.Mutex
	i := 0
	p, err := NewProvider(optsOf(obj(sc.Opts)), func(id string) llm.LanguageModel {
		return mockModel{modelID: id, sc: sc, i: &i, calls: &rec.Calls, mu: &mu}
	})
	if err != nil {
		t.Fatal(err)
	}
	req := requestOf(sc.Request)
	var chat func(context.Context, *blm.ChatRequest) (*blm.ChatResponse, error) = p.Chat
	var stream func(context.Context, *blm.ChatRequest, func(blm.ChatChunk)) error = p.Stream
	if sc.Tools != nil {
		b := p.WithTools(toolDefs(sc, p, req.ReqID, &rec.Execs, &mu))
		chat, stream = b.Chat, b.Stream
	}
	ctx := context.Background()
	var thrown error
	if sc.Mode == "chat" {
		res, err := chat(ctx, req)
		if err != nil {
			thrown = err
		} else {
			s := u.Stringify(res.Obj())
			rec.Result = &s
		}
	} else {
		thrown = stream(ctx, req, func(c blm.ChatChunk) { rec.Chunks = append(rec.Chunks, u.Stringify(c.Obj())) })
	}
	if thrown != nil {
		var m string
		if v, ok := thrown.(*ValueError); ok {
			m = jsString(v.Value)
		} else {
			m = thrown.Error()
		}
		rec.Error = &m
	}
	return rec
}

func loadGolden(t *testing.T) ([]scenario, []record) {
	b, err := os.ReadFile("testdata/b5-aisdk-scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var scs []scenario
	if err := json.Unmarshal(b, &scs); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open("testdata/b5_aisdk.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var recs []record
	if err := json.NewDecoder(z).Decode(&recs); err != nil {
		t.Fatal(err)
	}
	if len(scs) != len(recs) {
		t.Fatalf("scenarios %d != records %d", len(scs), len(recs))
	}
	return scs, recs
}

func sorted(s []string) []string {
	c := append([]string{}, s...)
	sort.Strings(c)
	return c
}

func strp(p *string) string {
	if p == nil {
		return "<undefined>"
	}
	return *p
}

// diff returns mismatch descriptions (empty = identical).
func diff(want, got record) []string {
	var out []string
	cmp := func(what string, w, g []string) {
		if len(w) != len(g) {
			out = append(out, what+": count "+itoa(len(w))+" != "+itoa(len(g)))
		}
		for i := 0; i < len(w) && i < len(g); i++ {
			if w[i] != g[i] {
				out = append(out, what+"["+itoa(i)+"]:\n  want "+w[i]+"\n  got  "+g[i])
			}
		}
	}
	cmp("calls", want.Calls, got.Calls)
	cmp("chunks", want.Chunks, got.Chunks)
	cmp("execs", sorted(want.Execs), sorted(got.Execs)) // parallel tools: start order is a multiset
	if strp(want.Result) != strp(got.Result) {
		out = append(out, "result:\n  want "+strp(want.Result)+"\n  got  "+strp(got.Result))
	}
	if strp(want.Error) != strp(got.Error) {
		out = append(out, "error:\n  want "+strp(want.Error)+"\n  got  "+strp(got.Error))
	}
	return out
}

func itoa(n int) string { return u.FormatNumber(float64(n)) }

func TestB5AiSdkParity(t *testing.T) {
	scs, recs := loadGolden(t)
	calls, chunks, execs := 0, 0, 0
	for i := range scs {
		sc, want := &scs[i], recs[i]
		t.Run(sc.Name, func(t *testing.T) {
			got := replay(t, sc)
			for _, d := range diff(want, got) {
				t.Error(d)
			}
		})
		calls += len(want.Calls)
		chunks += len(want.Chunks)
		execs += len(want.Execs)
	}
	t.Logf("parity: %d scenarios, %d model calls, %d chunks, %d tool execs", len(scs), calls, chunks, execs)
}

// TestB5AiSdkParityMutation: the comparison must catch a perturbed golden and a perturbed runtime.
func TestB5AiSdkParityMutation(t *testing.T) {
	scs, recs := loadGolden(t)
	for i := range scs {
		got := replay(t, &scs[i])
		m := recs[i]
		switch {
		case len(m.Chunks) > 0:
			m.Chunks = append([]string{}, m.Chunks...)
			m.Chunks[len(m.Chunks)-1] += " "
		case m.Result != nil:
			s := *m.Result + " "
			m.Result = &s
		default:
			s := strp(m.Error) + " "
			m.Error = &s
		}
		if len(diff(m, got)) == 0 {
			t.Errorf("%s: mutated golden not detected", scs[i].Name)
		}
	}
	// runtime mutation: a different tool-output clip length must break tool-errors
	old := toolOutputMax
	toolOutputMax = 5999
	defer func() { toolOutputMax = old }()
	for i := range scs {
		if scs[i].Name == "tool-errors" && len(diff(recs[i], replay(t, &scs[i]))) == 0 {
			t.Error("runtime mutation (toolOutputMax) not detected")
		}
	}
}
