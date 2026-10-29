package facade

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 回放 scripts/parity/record-b5-chat.mjs（Node chatContext.ts + ChatFacade.ts）录制的 golden。

type chatSpec struct {
	Tokens []string `json:"tokens"`
	Fit    []struct {
		Messages []blm.ChatMessage `json:"messages"`
		Budget   *struct {
			MaxTokens   *float64 `json:"maxTokens"`
			MaxMessages *float64 `json:"maxMessages"`
		} `json:"budget"`
	} `json:"fit"`
	Facade []facadeScenario `json:"facade"`
}

type facadeScenario struct {
	Name      string `json:"name"`
	Providers []struct {
		ID          string           `json:"id"`
		WithTools   bool             `json:"withTools"`
		Stream      []map[string]any `json:"stream"`
		StreamThrow string           `json:"streamThrow"`
	} `json:"providers"`
	Resolve map[string]struct {
		ID    string  `json:"id"`
		Model *string `json:"model"`
	} `json:"resolve"`
	Tools      []string `json:"tools"`
	NoRegistry bool     `json:"noRegistry"`
	Calls      []struct {
		Op    string          `json:"op"`
		Opts  json.RawMessage `json:"opts"`
		ReqID string          `json:"reqId"`
	} `json:"calls"`
}

func loadJSON(t *testing.T, path string, gz bool, v any) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var dec *json.Decoder
	if gz {
		r, err := gzip.NewReader(f)
		if err != nil {
			t.Fatal(err)
		}
		dec = json.NewDecoder(r)
	} else {
		dec = json.NewDecoder(f)
	}
	if err := dec.Decode(v); err != nil {
		t.Fatal(err)
	}
}

func canon(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func chunkFrom(m map[string]any) blm.ChatChunk {
	c := blm.ChatChunk{Type: m["type"].(string)}
	if s, ok := m["content"].(string); ok {
		c.Content = s
	}
	if s, ok := m["finishReason"].(string); ok {
		c.FinishReason = s
	}
	return c
}

type fakeLog struct {
	mu    sync.Mutex
	l     []any
	given map[string]bool
}

func (f *fakeLog) add(v any) { f.mu.Lock(); f.l = append(f.l, v); f.mu.Unlock() }

func (f *fakeLog) rid(id string) string {
	if f.given[id] {
		return id
	}
	return "<rand>"
}

func (f *fakeLog) req(r *blm.ChatRequest) map[string]any {
	m := map[string]any{"reqId": f.rid(r.ReqID), "provider": r.Provider, "model": r.Model, "messages": r.Messages}
	if r.Temperature != nil {
		m["temperature"] = *r.Temperature
	}
	if r.TopP != nil {
		m["topP"] = *r.TopP
	}
	if r.MaxTokens != nil {
		m["maxTokens"] = *r.MaxTokens
	}
	if r.Stream != nil {
		m["stream"] = *r.Stream
	}
	if r.Extra != nil {
		m["extra"] = r.Extra
	}
	return m
}

type fakeProv struct {
	id     string
	chunks []map[string]any
	throw  string
	log    *fakeLog
}

func (p *fakeProv) ProviderID() string { return p.id }
func (p *fakeProv) Chat(_ context.Context, r *blm.ChatRequest) (*blm.ChatResponse, error) {
	p.log.add(map[string]any{"ev": "chat", "id": p.id, "req": p.log.req(r)})
	return &blm.ChatResponse{ReqID: r.ReqID, Provider: p.id, Model: r.Model, Content: "ok:" + p.id, FinishReason: "stop"}, nil
}
func (p *fakeProv) Stream(_ context.Context, r *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	p.log.add(map[string]any{"ev": "stream", "id": p.id, "req": p.log.req(r)})
	for _, c := range p.chunks {
		emit(chunkFrom(c))
	}
	if p.throw != "" {
		return errors.New(p.throw)
	}
	return nil
}
func (p *fakeProv) Abort(id string) {
	p.log.add(map[string]any{"ev": "abort", "id": p.id, "reqId": id})
}

type fakeToolProv struct{ *fakeProv }

type fakeRunner struct{ p *fakeProv }

func (r fakeRunner) Chat(_ context.Context, req *blm.ChatRequest) (*blm.ChatResponse, error) {
	r.p.log.add(map[string]any{"ev": "tools.chat", "id": r.p.id, "req": r.p.log.req(req)})
	return &blm.ChatResponse{ReqID: req.ReqID, Provider: r.p.id, Model: req.Model, Content: "tools:" + r.p.id, FinishReason: "stop"}, nil
}
func (r fakeRunner) Stream(ctx context.Context, req *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	r.p.log.add(map[string]any{"ev": "tools.stream", "id": r.p.id})
	return r.p.Stream(ctx, req, emit)
}
func (p fakeToolProv) WithTools(defs []tools.Definition) blm.ToolRunner {
	names := []string{}
	for _, d := range defs {
		names = append(names, d.Name)
	}
	p.log.add(map[string]any{"ev": "withTools", "id": p.id, "tools": names})
	return fakeRunner{p.fakeProv}
}

type fakeReg struct {
	list []blm.LLMProvider
	sc   *facadeScenario
}

func (r *fakeReg) Get(id string) blm.LLMProvider {
	for _, p := range r.list {
		if p.ProviderID() == id {
			return p
		}
	}
	return nil
}
func (r *fakeReg) List() []blm.LLMProvider { return r.list }
func (r *fakeReg) Resolve(role string) (blm.LLMProvider, *string, bool) {
	x, ok := r.sc.Resolve[role]
	if !ok {
		return nil, nil, false
	}
	return r.Get(x.ID), x.Model, true
}

func runFacade(sc *facadeScenario) []any {
	lg := &fakeLog{}
	reg := &fakeReg{sc: sc}
	for _, p := range sc.Providers {
		fp := &fakeProv{id: p.ID, chunks: p.Stream, throw: p.StreamThrow, log: lg}
		if p.WithTools {
			reg.list = append(reg.list, fakeToolProv{fp})
		} else {
			reg.list = append(reg.list, fp)
		}
	}
	d := Deps{
		Now:   func() int64 { return 1_700_000_000_000 },
		NewID: func() string { return "<generated>" },
		Emit: func(ev string, payload *u.Obj) {
			var p map[string]any
			_ = json.Unmarshal([]byte(u.Stringify(payload)), &p)
			msg := p["message"].(map[string]any)
			id := lg.rid(msg["id"].(string))
			msg["id"], msg["sessionId"] = id, id
			lg.add(map[string]any{"ev": "emit", "event": ev, "payload": p})
		},
	}
	if !sc.NoRegistry {
		d.LLM = func() Registry { return reg }
	}
	if sc.Tools != nil {
		tr := tools.NewInMemory()
		for _, n := range sc.Tools {
			tr.Register(tools.Definition{Name: n, Description: n, Input: u.NewObj()})
		}
		d.Tools = func() tools.Registry { return tr }
	}
	c := NewChat(d)
	ctx := context.Background()
	for _, call := range sc.Calls {
		lg.given = map[string]bool{}
		entry := map[string]any{"op": call.Op}
		if call.Op == "abort" {
			c.Abort(call.ReqID)
			lg.add(entry)
			continue
		}
		var o ChatStreamOptions
		if err := json.Unmarshal(call.Opts, &o); err != nil {
			entry["error"] = "decode: " + err.Error()
			lg.add(entry)
			continue
		}
		if o.ReqID != nil {
			lg.given[*o.ReqID] = true
		}
		var err error
		switch call.Op {
		case "sendMessage", "agent":
			var res *blm.ChatResponse
			if call.Op == "agent" {
				res, err = c.Agent(ctx, &o)
			} else {
				res, err = c.SendMessage(ctx, &o)
			}
			if err == nil {
				var r map[string]any
				_ = json.Unmarshal([]byte(u.Stringify(res.Obj())), &r)
				r["reqId"] = lg.rid(r["reqId"].(string))
				entry["result"] = r
			}
		default:
			chunks := []any{}
			emit := func(ch blm.ChatChunk) { chunks = append(chunks, ch.Obj()) }
			switch call.Op {
			case "stream":
				err = c.Stream(ctx, &o, emit)
			case "agentStream":
				err = c.AgentStream(ctx, &o, emit)
			case "regenerate":
				err = c.Regenerate(ctx, &o, emit)
			}
			entry["chunks"] = chunks
		}
		if err != nil {
			entry["error"] = err.Error()
		}
		lg.add(entry)
	}
	return lg.l
}

func replayChat(t *testing.T, spec *chatSpec) map[string]any {
	toks := []any{}
	for _, s := range spec.Tokens {
		toks = append(toks, EstimateTokens(s))
	}
	fit := []any{}
	for _, f := range spec.Fit {
		var b *ContextBudget
		if f.Budget != nil {
			b = &ContextBudget{MaxTokens: f.Budget.MaxTokens, MaxMessages: f.Budget.MaxMessages}
		}
		msgs := f.Messages
		if msgs == nil {
			msgs = []blm.ChatMessage{}
		}
		out := FitMessagesToBudget(msgs, b)
		if out == nil {
			out = []blm.ChatMessage{}
		}
		fit = append(fit, out)
	}
	fac := []any{}
	for i := range spec.Facade {
		fac = append(fac, map[string]any{"name": spec.Facade[i].Name, "log": runFacade(&spec.Facade[i])})
	}
	return canon(t, map[string]any{"tokens": toks, "fit": fit, "facade": fac}).(map[string]any)
}

func loadChatGolden(t *testing.T) (*chatSpec, map[string]any) {
	var spec chatSpec
	loadJSON(t, "../../../../../../scripts/parity/b5-chat-scenarios.json", false, &spec)
	var want map[string]any
	loadJSON(t, "testdata/parity/b5_chat.json.gz", true, &want)
	return &spec, want
}

func diffChat(want, got map[string]any) []string {
	var out []string
	for _, k := range []string{"tokens", "fit"} {
		w, g := want[k].([]any), got[k].([]any)
		for i := range w {
			if i >= len(g) || !reflect.DeepEqual(w[i], g[i]) {
				wb, _ := json.Marshal(w[i])
				gb, _ := json.Marshal(g)
				if i < len(g) {
					gb, _ = json.Marshal(g[i])
				}
				out = append(out, k+": want "+string(wb)+"\n got "+string(gb))
			}
		}
	}
	w, g := want["facade"].([]any), got["facade"].([]any)
	for i := range w {
		if i >= len(g) || !reflect.DeepEqual(w[i], g[i]) {
			wb, _ := json.Marshal(w[i])
			gb := []byte("<missing>")
			if i < len(g) {
				gb, _ = json.Marshal(g[i])
			}
			out = append(out, "facade: want "+string(wb)+"\n got "+string(gb))
		}
	}
	return out
}

func TestChatParity(t *testing.T) {
	spec, want := loadChatGolden(t)
	got := replayChat(t, spec)
	for _, d := range diffChat(want, got) {
		t.Error(d)
	}
	t.Logf("b5-chat parity: %d tokens, %d fit, %d facade scenarios", len(spec.Tokens), len(spec.Fit), len(spec.Facade))
}

// 变更检测：改动回放结果必须被比对发现
func TestChatParityMutation(t *testing.T) {
	spec, want := loadChatGolden(t)
	for _, mut := range []func(map[string]any){
		func(g map[string]any) { g["tokens"].([]any)[3] = 99.0 },
		func(g map[string]any) { g["fit"].([]any)[6] = []any{} },
		func(g map[string]any) {
			sc := g["facade"].([]any)[7].(map[string]any)
			sc["log"] = sc["log"].([]any)[1:]
		},
	} {
		got := replayChat(t, spec)
		mut(got)
		if len(diffChat(want, got)) == 0 {
			t.Fatal("mutation not detected")
		}
	}
}
