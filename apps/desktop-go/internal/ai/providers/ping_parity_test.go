package providers

// D-B4d-3 golden：scripts/parity/record-b5-ping.mjs 用真 ProviderService.ts 录制；
// Go 侧用同样的脚本化 fetch / factory 逐条比对。

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

type pingFetch struct {
	spec *u.Obj
	logv func(string, any)
}

func (f pingFetch) RoundTrip(r *http.Request) (*http.Response, error) {
	var ks []string
	for k := range r.Header {
		ks = append(ks, strings.ToLower(k))
	}
	sort.Strings(ks)
	h := u.NewObj()
	for _, k := range ks {
		h.Set(k, r.Header.Get(k))
	}
	f.logv("fetch", u.NewObj("url", r.URL.String(), "headers", h))
	b := obj(obj(f.spec.Get("fetch")).Get(r.URL.String()))
	if b == nil || b.Get("network") == true {
		return nil, errors.New("dial tcp: no such host")
	}
	if b.Get("hang") == true {
		<-r.Context().Done()
		return nil, r.Context().Err()
	}
	return &http.Response{StatusCode: int(num(b.Get("status"))), Body: io.NopCloser(strings.NewReader(str(b.Get("body")))), Header: http.Header{}, Request: r}, nil
}

type pingProv struct {
	b    *u.Obj
	logv func(string, any)
}

func (p *pingProv) ProviderID() string { return "x" }
func (p *pingProv) Abort(string)       {}
func (p *pingProv) Stream(context.Context, *blm.ChatRequest, func(blm.ChatChunk)) error {
	return nil
}
func (p *pingProv) Chat(ctx context.Context, r *blm.ChatRequest) (*blm.ChatResponse, error) {
	var msgs []any
	for _, m := range r.Messages {
		msgs = append(msgs, u.NewObj("role", m.Role, "content", m.Content))
	}
	p.logv("chatReq", u.NewObj("reqId", r.ReqID, "provider", r.Provider, "model", r.Model, "messages", msgs,
		"maxTokens", *r.MaxTokens, "stream", *r.Stream))
	if p.b == nil {
		return nil, errors.New("no behavior")
	}
	if p.b.Get("hang") == true {
		select {}
	}
	if s, ok := p.b.Get("throw").(string); ok {
		return nil, errors.New(s)
	}
	res := obj(p.b.Get("res"))
	return &blm.ChatResponse{ReqID: r.ReqID, Provider: r.Provider, FinishReason: "stop", Model: str(res.Get("model")), Content: str(res.Get("content"))}, nil
}

type envReg map[string]blm.LLMProvider

func (e envReg) Resolve(string) (Resolved, bool) { return Resolved{}, false }
func (e envReg) Get(id string) blm.LLMProvider   { return e[id] }

func pickPingOpts(o aisdk.Options) *u.Obj {
	out := u.NewObj("id", o.ID, "protocol", o.Protocol, "baseURL", o.BaseURL)
	if o.FullURL != nil {
		out.Set("fullUrl", *o.FullURL)
	}
	out.Set("defaultModel", o.DefaultModel)
	if o.ModelMap != nil {
		out.Set("modelMap", o.ModelMap)
	}
	if h, ok := o.Headers.(*u.Obj); ok && h != nil {
		out.Set("headers", h)
	}
	if o.UserAgent != "" {
		out.Set("userAgent", o.UserAgent)
	}
	if o.Thinking != nil {
		out.Set("thinking", *o.Thinking)
	}
	if o.APIKey != "" {
		out.Set("apiKey", o.APIKey)
	}
	if o.RequiresAPIKey != nil {
		out.Set("requiresApiKey", *o.RequiresAPIKey)
	}
	return out
}

func pingStoreJSON(spec *u.Obj) string {
	var ps []any
	for _, pv := range arr(spec.Get("providers")) {
		p := obj(pv)
		o := u.NewObj("id", p.Get("id"), "presetId", p.Get("presetId"), "name", p.Get("id"), "protocol", p.Get("protocol"),
			"baseURL", p.Get("baseURL"), "fullUrl", false)
		dm, _ := p.Get("defaultModel").(string)
		o.Set("defaultModel", dm).Set("models", []any{})
		if h := obj(p.Get("headers")); h != nil {
			o.Set("headers", h)
		}
		if ua := str(p.Get("userAgent")); ua != "" {
			o.Set("userAgent", ua)
		}
		o.Set("enabled", true)
		keys := []any{}
		for i, k := range arr(p.Get("keys")) {
			keys = append(keys, u.NewObj("id", "k"+u.FormatNumber(float64(i)), "secret", base64.StdEncoding.EncodeToString([]byte(str(k))),
				"encryption", "none", "masked", "****", "createdAt", 1.0))
		}
		o.Set("keys", keys).Set("createdAt", 1.0).Set("updatedAt", 1.0)
		ps = append(ps, o)
	}
	return u.Stringify(u.NewObj("version", 2.0, "providers", ps, "routes", u.NewObj(), "usage", u.NewObj()))
}

func replayPing(t *testing.T, spec *u.Obj) []string {
	var ev []string
	var evMu sync.Mutex
	// 超时后仍在跑的 provider goroutine 也会记事件：加锁，结束时取快照
	logv := func(k string, v any) {
		line := k + ":" + u.Stringify(v)
		evMu.Lock()
		ev = append(ev, line)
		evMu.Unlock()
	}
	file := filepath.Join(t.TempDir(), "p.json")
	if err := os.WriteFile(file, []byte(pingStoreJSON(spec)), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(StoreOptions{FilePath: file, Cipher: PlaintextCipher, Now: func() float64 { return routerNowMs }, UsageFlushMs: 3_600_000})
	chat := obj(spec.Get("chat"))
	reg := envReg{"openai": &pingProv{b: obj(chat.Get("env:openai")), logv: logv}}
	svc := NewService(ServiceOptions{
		Store:       store,
		GetRegistry: func() RoutedRegistry { return reg },
		Factory: func(o aisdk.Options) (blm.LLMProvider, error) {
			logv("factory", pickPingOpts(o))
			b := obj(chat.Get(o.APIKey))
			if c, ok := b.Get("ctor").(string); b != nil && ok {
				return nil, errors.New(c)
			}
			return &pingProv{b: b, logv: logv}, nil
		},
		TestTimeout: 50 * time.Millisecond,
		Client:      &http.Client{Transport: pingFetch{spec: spec, logv: logv}},
	})
	for _, opv := range arr(spec.Get("ops")) {
		op := obj(opv)
		name := str(op.Get("op"))
		var res *u.Obj
		var err error
		switch name {
		case "fetchModels":
			res, err = svc.FetchModels(str(op.Get("id")))
		case "fetchModelsDraft":
			res, err = svc.FetchModelsDraft(obj(op.Get("input")))
		case "test":
			res, err = svc.Test(str(op.Get("id")), str(op.Get("keyId")))
		case "testDraft":
			res, err = svc.TestDraft(obj(op.Get("input")))
		}
		if err != nil {
			logv("opErr", err.Error())
		} else {
			logv(name, res)
		}
	}
	logv("views", store.List())
	evMu.Lock()
	defer evMu.Unlock()
	return append([]string(nil), ev...)
}

func runPingGolden(t *testing.T) (events, bad int, diffs []string) {
	spec := obj(readJSON(t, paritytest.RepoPath("scripts/parity/b5-ping-scenarios.json"), false))
	want := arr(obj(readJSON(t, "testdata/parity/b5_ping.json.gz", true)).Get("events"))
	old := serviceNow
	serviceNow = func() time.Time { return time.UnixMilli(routerNowMs) }
	defer func() { serviceNow = old }()
	got := replayPing(t, spec)
	n := len(want)
	if len(got) > n {
		n = len(got)
	}
	for i := 0; i < n; i++ {
		var w, g string
		if i < len(want) {
			w = str(want[i])
		}
		if i < len(got) {
			g = got[i]
		}
		if w != g {
			bad++
			diffs = append(diffs, "#"+u.FormatNumber(float64(i))+"\n  node: "+w+"\n  go:   "+g)
		}
	}
	return len(want), bad, diffs
}

func TestPingParityGolden(t *testing.T) {
	n, bad, diffs := runPingGolden(t)
	for _, d := range diffs {
		t.Error(d)
	}
	if bad == 0 {
		t.Logf("ping golden: %d events identical to Node", n)
	}
}

func TestPingParityMutation(t *testing.T) {
	old := secretLike
	secretLike = statusRe
	if _, bad, _ := runPingGolden(t); bad == 0 {
		t.Error("runtime mutation (redaction regex) not detected")
	}
	secretLike = old
	if _, bad, _ := runPingGolden(t); bad != 0 {
		t.Fatal("restore failed")
	}
}
