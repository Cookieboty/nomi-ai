package providers

// 回放 scripts/parity/record-b5-router.mjs 录制的 testdata/parity/b5_router.json.gz（D-B5-9）：
// 真 ProviderRouter.ts + ProviderStore 跑脚本化 fake provider 的完整事件序列，逐条比对。
// 重新录制：node scripts/parity/record-b5-router.mjs

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

const routerNowMs = 1_700_000_000_000

func readJSON(t *testing.T, path string, gz bool) any {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var r io.Reader = f
	if gz {
		zr, err := gzip.NewReader(f)
		if err != nil {
			t.Fatal(err)
		}
		r = zr
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	v, err := u.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func obj(v any) *u.Obj  { o, _ := v.(*u.Obj); return o }
func str(v any) string  { s, _ := v.(string); return s }
func num(v any) float64 { f, _ := v.(float64); return f }

func usageOf(v any) *blm.ChatUsage {
	o := obj(v)
	if o == nil {
		return nil
	}
	c := &blm.ChatUsage{PromptTokens: num(o.Get("promptTokens")), CompletionTokens: num(o.Get("completionTokens")), TotalTokens: num(o.Get("totalTokens"))}
	opt := func(k string) *float64 {
		if f, ok := o.Get(k).(float64); ok {
			return &f
		}
		return nil
	}
	c.CacheReadTokens, c.CacheWriteTokens = opt("cacheReadTokens"), opt("cacheWriteTokens")
	return c
}

func optStr(o *u.Obj, k string) *string {
	if s, ok := o.Get(k).(string); ok {
		return &s
	}
	return nil
}

func chunkOf(o *u.Obj) blm.ChatChunk {
	return blm.ChatChunk{Type: str(o.Get("type")), Content: str(o.Get("content")), Error: optStr(o, "error"),
		Usage: usageOf(o.Get("usage")), Model: optStr(o, "model"), FinishReason: str(o.Get("finishReason"))}
}

type scriptedProv struct {
	id string
	b  *u.Obj
}

func (p *scriptedProv) ProviderID() string { return p.id }
func (p *scriptedProv) Abort(string)       {}
func (p *scriptedProv) Chat(_ context.Context, r *blm.ChatRequest) (*blm.ChatResponse, error) {
	c := obj(p.b.Get("chat"))
	if th := obj(c.Get("throw")); th != nil {
		if th.Get("plain") == true {
			return nil, errors.New(str(th.Get("message")))
		}
		return nil, &llm.APICallError{Message: str(th.Get("message")), StatusCode: int(num(th.Get("statusCode")))}
	}
	res := obj(c.Get("res"))
	return &blm.ChatResponse{ReqID: r.ReqID, Provider: p.id, Model: str(res.Get("model")), Content: str(res.Get("content")),
		FinishReason: str(res.Get("finishReason")), Usage: usageOf(res.Get("usage"))}, nil
}
func (p *scriptedProv) Stream(ctx context.Context, _ *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	for _, c := range arr(p.b.Get("stream")) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		emit(chunkOf(obj(c)))
	}
	if s, ok := p.b.Get("streamThrow").(string); ok {
		return errors.New(s)
	}
	return nil
}

func storeFileJSON(sc *u.Obj) string {
	s := obj(sc.Get("store"))
	var ps []any
	for _, pv := range arr(s.Get("providers")) {
		p := obj(pv)
		o := u.NewObj("id", p.Get("id"), "presetId", p.Get("presetId"), "name", p.Get("id"), "protocol", p.Get("protocol"),
			"baseURL", p.Get("baseURL"), "fullUrl", false)
		dm := ""
		if v, ok := p.Get("defaultModel").(string); ok {
			dm = v
		}
		o.Set("defaultModel", dm).Set("models", []any{})
		if mm := p.Get("modelMap"); mm != nil && mm != u.Undefined {
			o.Set("modelMap", mm)
		}
		o.Set("enabled", p.Get("enabled") != false)
		var keys []any = []any{}
		for i, k := range arr(p.Get("keys")) {
			keys = append(keys, u.NewObj("id", "k"+u.FormatNumber(float64(i)), "secret", base64.StdEncoding.EncodeToString([]byte(str(k))),
				"encryption", "none", "masked", "****", "createdAt", 1.0))
		}
		o.Set("keys", keys).Set("createdAt", 1.0).Set("updatedAt", 1.0)
		ps = append(ps, o)
	}
	d := u.NewObj("version", 2.0, "providers", ps)
	if a, ok := s.Get("activeProviderId").(string); ok {
		d.Set("activeProviderId", a)
	}
	rt := s.Get("routes")
	if obj(rt) == nil {
		rt = u.NewObj()
	}
	d.Set("routes", rt).Set("usage", u.NewObj())
	return u.Stringify(d)
}

func pickOpts(o aisdk.Options) *u.Obj {
	out := u.NewObj("id", o.ID, "protocol", o.Protocol, "baseURL", o.BaseURL)
	if o.FullURL != nil {
		out.Set("fullUrl", *o.FullURL)
	}
	out.Set("defaultModel", o.DefaultModel)
	if o.APIKey != "" {
		out.Set("apiKey", o.APIKey)
	}
	if o.RequiresAPIKey != nil {
		out.Set("requiresApiKey", *o.RequiresAPIKey)
	}
	if o.Receiver != nil {
		out.Set("receiver", u.NewObj("id", o.Receiver.ID, "baseURL", o.Receiver.BaseURL))
	}
	if o.ServedModelHeader != "" {
		out.Set("servedModelHeader", o.ServedModelHeader)
	}
	if o.RedactedHeader != "" {
		out.Set("redactedHeader", o.RedactedHeader)
	}
	return out
}

type gwMap struct{ m *u.Obj }

func (g gwMap) Resolve(role string) *GatewayResolution {
	v := g.m.Get(role)
	if !g.m.Has(role) {
		v = g.m.Get("default")
	}
	o := obj(v)
	if o == nil {
		return nil
	}
	rc := obj(o.Get("receiver"))
	return &GatewayResolution{BaseURL: str(o.Get("baseURL")), Token: str(o.Get("token")), Model: str(o.Get("model")),
		Protocol: str(o.Get("protocol")), Receiver: tools.ToolCallProvider{ID: str(rc.Get("id")), BaseURL: str(rc.Get("baseURL"))}}
}

func reqOf(v any) *blm.ChatRequest {
	o := obj(v)
	r := &blm.ChatRequest{ReqID: str(o.Get("reqId")), Model: str(o.Get("model"))}
	for _, m := range arr(o.Get("messages")) {
		mo := obj(m)
		r.Messages = append(r.Messages, blm.ChatMessage{Role: str(mo.Get("role")), Content: str(mo.Get("content"))})
	}
	return r
}

func replayRouter(t *testing.T, behaviors *u.Obj, sc *u.Obj) []string {
	var ev []string
	logv := func(k string, v any) { ev = append(ev, k+":"+u.Stringify(v)) }
	behavior := func(id, key string) *u.Obj {
		for _, k := range []string{key, id, "k-nousage"} {
			if b := obj(behaviors.Get(k)); k != "" && b != nil {
				return b
			}
		}
		return nil
	}
	var store *Store
	if sc.Get("noStore") != true {
		file := filepath.Join(t.TempDir(), "p.json")
		if err := os.WriteFile(file, []byte(storeFileJSON(sc)), 0o600); err != nil {
			t.Fatal(err)
		}
		store = NewStore(StoreOptions{FilePath: file, Cipher: PlaintextCipher, Now: func() float64 { return routerNowMs },
			UsageFlushMs: 3_600_000, OnCall: func(e any) { logv("call", e) }})
	}
	var env []blm.LLMProvider
	for _, id := range arr(sc.Get("env")) {
		env = append(env, &scriptedProv{id: str(id), b: behavior(str(id), "")})
	}
	opts := RoutedRegistryOptions{
		Store: store, EnvProviders: env, OverrideID: str(sc.Get("override")),
		Factory: func(o aisdk.Options) (blm.LLMProvider, error) {
			logv("factory", pickOpts(o))
			return &scriptedProv{id: o.ID, b: behavior(o.ID, o.APIKey)}, nil
		},
		OnError: func(m string, err error) { logv("onError", m+" "+err.Error()) },
		OnCall:  func(e *u.Obj) { logv("log", e) },
	}
	var gw *u.Obj
	if g := obj(sc.Get("gateway")); g != nil {
		gw = g
		opts.Gateway = gwMap{gw}
	}
	reg := NewRoutedLLMRegistry(opts)
	resolve := func(op *u.Obj) blm.LLMProvider {
		if id, ok := op.Get("id").(string); ok {
			return reg.Get(id)
		}
		role := str(op.Get("role"))
		if r := reg.ResolveProvider(role); r != nil {
			return r.Provider
		}
		return nil
	}
	for _, opv := range arr(sc.Get("ops")) {
		op := obj(opv)
		switch str(op.Get("op")) {
		case "resolve":
			r := reg.ResolveProvider(str(op.Get("role")))
			if r == nil {
				logv("resolve", nil)
				break
			}
			o := u.NewObj("id", r.Provider.ProviderID())
			if r.Model != nil {
				o.Set("model", *r.Model)
			}
			logv("resolve", o)
		case "list":
			ids := []any{}
			for _, p := range reg.List() {
				ids = append(ids, p.ProviderID())
			}
			logv("list", ids)
		case "setActive":
			id := op.Get("id")
			if id == nil {
				id = u.Undefined
			}
			if err := store.SetActive(id, u.Undefined); err != nil {
				t.Fatal(err)
			}
			logv("setActive", op.Get("id"))
		case "setGateway":
			gw.Set(str(op.Get("role")), op.Get("value"))
			logv("setGateway", op.Get("role"))
		case "chat", "chatId":
			res, err := resolve(op).Chat(context.Background(), reqOf(op.Get("req")))
			if err != nil {
				logv("chatErr", err.Error())
			} else {
				logv("chat", res.Obj())
			}
		case "stream", "streamId":
			err := resolve(op).Stream(context.Background(), reqOf(op.Get("req")), func(c blm.ChatChunk) { logv("chunk", c.Obj()) })
			if err != nil {
				logv("streamErr", err.Error())
			}
		default:
			t.Fatalf("bad op %v", op.Get("op"))
		}
	}
	if store != nil {
		logv("usage", store.Usage())
		logv("views", store.List())
	}
	return ev
}

func runRouterGolden(t *testing.T) (scenarios, events, mismatched int, diffs []string) {
	old := routerNow
	routerNow = func() time.Time { return time.UnixMilli(routerNowMs) }
	defer func() { routerNow = old }()
	spec := obj(readJSON(t, paritytest.RepoPath("scripts/parity/b5-router-scenarios.json"), false))
	recs := arr(readJSON(t, "testdata/parity/b5_router.json.gz", true))
	scs := arr(spec.Get("scenarios"))
	if len(scs) != len(recs) {
		t.Fatalf("scenarios %d != records %d", len(scs), len(recs))
	}
	for i, scv := range scs {
		sc, rec := obj(scv), obj(recs[i])
		want := arr(rec.Get("events"))
		got := replayRouter(t, obj(spec.Get("behaviors")), sc)
		scenarios++
		events += len(want)
		bad := len(got) != len(want)
		for j := 0; j < len(want) || j < len(got); j++ {
			var g, w string
			if j < len(got) {
				g = got[j]
			}
			if j < len(want) {
				w = str(want[j])
			}
			if g != w {
				bad = true
				diffs = append(diffs, str(sc.Get("name"))+"#"+u.FormatNumber(float64(j))+"\n got: "+g+"\nwant: "+w)
				break
			}
		}
		if bad {
			mismatched++
		}
	}
	return
}

func TestRouterParityGolden(t *testing.T) {
	n, ev, bad, diffs := runRouterGolden(t)
	if bad > 0 {
		t.Fatalf("%d/%d scenarios differ from Node:\n%s", bad, n, strings.Join(diffs, "\n"))
	}
	t.Logf("router golden: %d scenarios, %d events identical to Node", n, ev)
}

// TestRouterParityMutation：比对必须能抓到被改动的 golden 与被改动的运行时
func TestRouterParityMutation(t *testing.T) {
	spec := obj(readJSON(t, paritytest.RepoPath("scripts/parity/b5-router-scenarios.json"), false))
	recs := arr(readJSON(t, "testdata/parity/b5_router.json.gz", true))
	old := routerNow
	routerNow = func() time.Time { return time.UnixMilli(routerNowMs) }
	for i, scv := range arr(spec.Get("scenarios")) {
		got := replayRouter(t, obj(spec.Get("behaviors")), obj(scv))
		want := arr(obj(recs[i]).Get("events"))
		mut := str(want[len(want)-1]) + " "
		if got[len(got)-1] == mut {
			t.Errorf("scenario %d: mutated golden not detected", i)
		}
	}
	routerNow = old

	// 运行时变异 1：429 不再算 key 错误
	delete(keyStatus, 429)
	if _, _, bad, _ := runRouterGolden(t); bad == 0 {
		t.Error("runtime mutation (keyStatus 429) not detected")
	}
	keyStatus[429] = true
	// 运行时变异 2：key 消息正则失效
	oldRe := keyMsgRe
	keyMsgRe = statusRe
	if _, _, bad, _ := runRouterGolden(t); bad == 0 {
		t.Error("runtime mutation (keyMsgRe) not detected")
	}
	keyMsgRe = oldRe
	// 运行时变异 3：估算 token 规则
	oldEst := estimateHook
	estimateHook = func(s string) float64 { return EstimateTokens(s) + 1 }
	if _, _, bad, _ := runRouterGolden(t); bad == 0 {
		t.Error("runtime mutation (estimateTokens) not detected")
	}
	estimateHook = oldEst
	if _, _, bad, d := runRouterGolden(t); bad != 0 {
		t.Fatalf("restore failed: %v", d)
	}
}
