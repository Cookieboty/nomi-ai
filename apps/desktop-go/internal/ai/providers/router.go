package providers

// router.go：ProviderRouter.ts —— TrackedProvider（多 key fallback + 记账）与 RoutedLLMRegistry（角色路由）。

import (
	"context"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
	"unicode/utf16"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/providers/protocol"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aisdk"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// UsageSink：UsageSink（nil 字段 = 未提供的可选方法）
type UsageSink struct {
	RecordUsage func(id string, usage *u.Obj, ok bool)
	MarkKey     func(id string, keyIndex int, errMsg *string)
	RecordCall  func(e *u.Obj)
	LogCall     func(e *u.Obj)
}

var keyStatus = map[int]bool{401: true, 402: true, 403: true, 429: true}

var statusRe = regexp.MustCompile(`(?i)\b(?:HTTP[/\s]*)?([45]\d{2})\b`)
var threeDigits = regexp.MustCompile(`^\d{3}$`)
var keyMsgRe = regexp.MustCompile(`(?i)unauthori[sz]ed|forbidden|invalid[_ ]?api[_ ]?key|incorrect api key|api key|quota|rate limit|insufficient|billing`)

// statusCoder：带 statusCode / status 字段的错误
type statusCoder interface{ HTTPStatus() (int, bool) }

// HTTPStatusOf：httpStatusOf(error)
func HTTPStatusOf(e any) (int, bool) {
	switch x := e.(type) {
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			return int(x), true
		}
	case int:
		return x, true
	case *llm.APICallError:
		if x.StatusCode != 0 {
			return x.StatusCode, true
		}
	case *llm.RetryError:
		if l := x.LastError(); l != nil && l != error(x) {
			if n, ok := HTTPStatusOf(l); ok {
				return n, true
			}
		}
	case *u.Obj:
		for _, k := range []string{"statusCode", "status", "status_code"} {
			switch v := x.Get(k).(type) {
			case float64:
				if !math.IsInf(v, 0) && !math.IsNaN(v) {
					return int(v), true
				}
			case string:
				if threeDigits.MatchString(v) {
					n, _ := strconv.Atoi(v)
					return n, true
				}
			}
		}
		if c := x.Get("cause"); !isUndef(c) && c != nil && c != any(x) {
			if n, ok := HTTPStatusOf(c); ok {
				return n, true
			}
		}
	case statusCoder:
		if n, ok := x.HTTPStatus(); ok {
			return n, true
		}
	}
	if err, ok := e.(error); ok {
		if c := errors.Unwrap(err); c != nil {
			if n, ok := HTTPStatusOf(c); ok {
				return n, true
			}
		}
	}
	if m := statusRe.FindStringSubmatch(errMessage(e)); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n, true
	}
	return 0, false
}

func errMessage(e any) string {
	switch x := e.(type) {
	case string:
		return x
	case error:
		return x.Error()
	case nil:
		return ""
	}
	if isUndef(e) {
		return ""
	}
	return jsString(e)
}

// IsKeyError：isKeyError(error)
func IsKeyError(e any) bool {
	if st, ok := HTTPStatusOf(e); ok {
		return keyStatus[st]
	}
	return keyMsgRe.MatchString(errMessage(e))
}

// EstimateTokens：estimateTokens(text)
func EstimateTokens(text string) float64 {
	if text == "" {
		return 0
	}
	cjk := 0
	for _, c := range text {
		if (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af) {
			cjk++
		}
	}
	rest := len(utf16.Encode([]rune(text))) - cjk
	return math.Max(1, math.Ceil(float64(cjk)/1.5+float64(rest)/4))
}

// TrackedProvider：TrackedProvider
type TrackedProvider struct {
	ID           string
	candidates   []blm.LLMProvider
	sink         *UsageSink
	defaultModel string
	modelMap     []any
	now          func() time.Time
}

// NewTrackedProvider：new TrackedProvider(id, candidates, sink?, defaultModel?, modelMap?)
func NewTrackedProvider(id string, candidates []blm.LLMProvider, sink *UsageSink, defaultModel string, modelMap []any) (*TrackedProvider, error) {
	if len(candidates) == 0 {
		return nil, errors.New("[" + id + "] no candidates")
	}
	return &TrackedProvider{ID: id, candidates: candidates, sink: sink, defaultModel: defaultModel, modelMap: modelMap, now: time.Now}, nil
}

func (t *TrackedProvider) ProviderID() string { return t.ID }

type trackedRunner struct {
	t    *TrackedProvider
	defs []tools.Definition
}

func (r trackedRunner) Chat(ctx context.Context, req *blm.ChatRequest) (*blm.ChatResponse, error) {
	return r.t.runChat(req, func(p blm.LLMProvider) (*blm.ChatResponse, error) {
		if w, ok := p.(blm.WithToolsCapable); ok {
			return w.WithTools(r.defs).Chat(ctx, req)
		}
		return p.Chat(ctx, req)
	})
}

func (r trackedRunner) Stream(ctx context.Context, req *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	return r.t.runStream(ctx, req, emit, func(c context.Context, p blm.LLMProvider, e func(blm.ChatChunk)) error {
		if w, ok := p.(blm.WithToolsCapable); ok {
			return w.WithTools(r.defs).Stream(c, req, e)
		}
		return p.Stream(c, req, e)
	})
}

// WithTools：withTools(defs)
func (t *TrackedProvider) WithTools(defs []tools.Definition) blm.ToolRunner {
	return trackedRunner{t, defs}
}

func (t *TrackedProvider) Chat(ctx context.Context, req *blm.ChatRequest) (*blm.ChatResponse, error) {
	return t.runChat(req, func(p blm.LLMProvider) (*blm.ChatResponse, error) { return p.Chat(ctx, req) })
}

func (t *TrackedProvider) Stream(ctx context.Context, req *blm.ChatRequest, emit func(blm.ChatChunk)) error {
	return t.runStream(ctx, req, emit, func(c context.Context, p blm.LLMProvider, e func(blm.ChatChunk)) error {
		return p.Stream(c, req, e)
	})
}

func (t *TrackedProvider) Abort(reqID string) {
	for _, c := range t.candidates {
		c.Abort(reqID)
	}
}

func aborted(req *blm.ChatRequest) bool {
	if req.Signal == nil {
		return false
	}
	select {
	case <-req.Signal:
		return true
	default:
		return false
	}
}

func usageIn(c *blm.ChatUsage) *u.Obj {
	if c == nil {
		return nil
	}
	return u.NewObj("inputTokens", c.PromptTokens, "outputTokens", c.CompletionTokens, "totalTokens", c.TotalTokens)
}

func (t *TrackedProvider) markKey(i int, msg *string) {
	if t.sink != nil && t.sink.MarkKey != nil {
		t.sink.MarkKey(t.ID, i, msg)
	}
}

func (t *TrackedProvider) recordUsage(us *u.Obj, ok bool) {
	if t.sink != nil && t.sink.RecordUsage != nil {
		t.sink.RecordUsage(t.ID, us, ok)
	}
}

func (t *TrackedProvider) runChat(req *blm.ChatRequest, call func(blm.LLMProvider) (*blm.ChatResponse, error)) (*blm.ChatResponse, error) {
	var lastErr error
	startedAt := t.now()
	for i, c := range t.candidates {
		res, err := call(c)
		if err == nil {
			t.markKey(i, nil)
			t.logCall(req, i, startedAt, false, &res.Model, nil)
			t.emitCall(req, startedAt, &res.Model, res.Usage, res.Content)
			t.recordUsage(usageIn(res.Usage), true)
			out := *res
			out.Provider = t.ID
			return &out, nil
		}
		lastErr = err
		msg := errMessage(err)
		t.markKey(i, &msg)
		t.logCall(req, i, startedAt, false, nil, &msg)
		more := i < len(t.candidates)-1
		if !more || !IsKeyError(err) || aborted(req) {
			break
		}
	}
	t.recordUsage(nil, false)
	return nil, lastErr
}

// billingModel：计费用的模型名
func (t *TrackedProvider) billingModel(req *blm.ChatRequest, resModel *string) string {
	if resModel != nil {
		if s := u.JSTrim(*resModel); s != "" {
			return s
		}
	}
	asked := t.defaultModel
	if req.Model != "" && req.Model != "default" {
		asked = req.Model
	}
	resolved := ""
	if asked != "" {
		resolved = u.JSTrim(protocol.MapModel(asked, t.modelMap))
	}
	if resolved == "" {
		return "unknown"
	}
	return resolved
}

func msSince(t0, t1 time.Time) float64 { return math.Max(0, float64(t1.UnixMilli()-t0.UnixMilli())) }

func (t *TrackedProvider) logCall(req *blm.ChatRequest, keyIndex int, startedAt time.Time, stream bool, resModel *string, errMsg *string) {
	if t.sink == nil || t.sink.LogCall == nil {
		return
	}
	defer func() { _ = recover() }()
	e := u.NewObj("provider", t.ID, "keyIndex", float64(keyIndex), "reqId", req.ReqID, "requested", req.Model,
		"model", t.billingModel(req, resModel), "stream", stream, "ok", errMsg == nil || *errMsg == "")
	if errMsg != nil && *errMsg != "" {
		e.Set("error", *errMsg)
	}
	e.Set("ms", msSince(startedAt, t.now()))
	t.sink.LogCall(e)
}

func (t *TrackedProvider) emitCall(req *blm.ChatRequest, startedAt time.Time, resModel *string, us *blm.ChatUsage, outText string) {
	if t.sink == nil || t.sink.RecordCall == nil {
		return
	}
	defer func() { _ = recover() }()
	e := u.NewObj("providerId", t.ID, "model", t.billingModel(req, resModel), "at", float64(startedAt.UnixMilli()), "reqId", req.ReqID)
	e.Set("durationMs", msSince(startedAt, t.now()))
	if us != nil && (us.PromptTokens != 0 || us.CompletionTokens != 0) {
		cr, cw := 0.0, 0.0
		if us.CacheReadTokens != nil {
			cr = *us.CacheReadTokens
		}
		if us.CacheWriteTokens != nil {
			cw = *us.CacheWriteTokens
		}
		e.Set("inputTokens", us.PromptTokens).Set("outputTokens", us.CompletionTokens).
			Set("cacheReadTokens", cr).Set("cacheWriteTokens", cw).Set("estimated", false)
		t.sink.RecordCall(e)
		return
	}
	in := ""
	for i, m := range req.Messages {
		if i > 0 {
			in += "\n"
		}
		in += m.Content
	}
	e.Set("inputTokens", EstimateTokens(in)).Set("outputTokens", EstimateTokens(outText)).
		Set("cacheReadTokens", 0.0).Set("cacheWriteTokens", 0.0).Set("estimated", true)
	t.sink.RecordCall(e)
}

// errSwitchKey：静默换下一个 key（for-await break）
var errSwitchKey = errors.New("switch key")

func (t *TrackedProvider) runStream(ctx context.Context, req *blm.ChatRequest, emit func(blm.ChatChunk),
	call func(context.Context, blm.LLMProvider, func(blm.ChatChunk)) error) error {
	startedAt := t.now()
	for i, c := range t.candidates {
		emitted := false
		outText := ""
		var usedModel *string
		var fullUsage *blm.ChatUsage
		var us *u.Obj
		var failed *string
		more := i < len(t.candidates)-1
		cctx, cancel := context.WithCancel(ctx)
		var mu sync.Mutex
		stopped := false
		err := call(cctx, c, func(ch blm.ChatChunk) {
			mu.Lock()
			defer mu.Unlock()
			if stopped {
				return
			}
			if ch.Type == "error" {
				failed = ch.Error
				var em any = u.Undefined
				if ch.Error != nil {
					em = *ch.Error
				}
				if !emitted && more && IsKeyError(em) && !aborted(req) {
					stopped = true
					cancel()
					return
				}
				emit(ch)
				return
			}
			if ch.Type == "delta" {
				outText += ch.Content
			}
			if ch.Type == "usage" {
				fullUsage, usedModel = ch.Usage, ch.Model
				us = usageIn(ch.Usage)
			}
			if ch.Type == "delta" || ch.Type == "tool_call.delta" || ch.Type == "reasoning" {
				emitted = true
			}
			emit(ch)
		})
		cancel()
		mu.Lock()
		stop := stopped
		mu.Unlock()
		if err != nil && !stop {
			return err
		}
		t.markKey(i, failed)
		t.logCall(req, i, startedAt, true, usedModel, failed)
		var fm any = u.Undefined
		if failed != nil {
			fm = *failed
		}
		if failed != nil && !emitted && more && IsKeyError(fm) && !aborted(req) {
			continue
		}
		t.recordUsage(us, failed == nil)
		if failed == nil {
			t.emitCall(req, startedAt, usedModel, fullUsage, outText)
		}
		return nil
	}
	return nil
}

// ProviderFactory：(opts) => LLMProvider（可 panic/返回错误 = 构造抛错）
type ProviderFactory func(opts aisdk.Options) (blm.LLMProvider, error)

const (
	GatewayProviderID     = "nomi-gateway"
	NomiServedModelHeader = "x-nomi-served-model"
	NomiRedactedHeader    = "x-nomi-redacted"
)

// DefaultProviderFactory：new AiSdkLlmProvider(opts)
func DefaultProviderFactory(opts aisdk.Options) (blm.LLMProvider, error) {
	return aisdk.NewProvider(opts, nil)
}

func boolPtr(b bool) *bool { return &b }

// StoredOptions：StoredProvider → AiSdkLlmProviderOptions base
func StoredOptions(p *u.Obj) aisdk.Options {
	o := aisdk.Options{ID: jsString(p.Get("id")), RequiresAPIKey: boolPtr(true)}
	o.Protocol, _ = p.Get("protocol").(string)
	o.BaseURL, _ = p.Get("baseURL").(string)
	if b, ok := p.Get("fullUrl").(bool); ok {
		o.FullURL = &b
	}
	o.DefaultModel, _ = p.Get("defaultModel").(string)
	o.ModelMap, _ = p.Get("modelMap").([]any)
	if b, ok := p.Get("thinking").(bool); ok {
		o.Thinking = &b
	}
	o.UserAgent, _ = p.Get("userAgent").(string)
	if h, ok := p.Get("headers").(*u.Obj); ok {
		o.Headers = h
	}
	return o
}

// BuildStoredProvider：buildStoredProvider
func BuildStoredProvider(p *u.Obj, keys []string, factory ProviderFactory, sink *UsageSink) (*TrackedProvider, error) {
	base := StoredOptions(p)
	var cands []blm.LLMProvider
	if len(keys) > 0 {
		for _, k := range keys {
			o := base
			o.APIKey = k
			c, err := factory(o)
			if err != nil {
				return nil, err
			}
			cands = append(cands, c)
		}
	} else {
		o := base
		o.RequiresAPIKey = boolPtr(false)
		c, err := factory(o)
		if err != nil {
			return nil, err
		}
		cands = append(cands, c)
	}
	return NewTrackedProvider(base.ID, cands, sink, base.DefaultModel, base.ModelMap)
}

// GatewayResolution：GatewayRoute.resolve 的返回
type GatewayResolution struct {
	BaseURL, Token, Model, Protocol string
	Receiver                        tools.ToolCallProvider
	Client                          *http.Client
}

// GatewayRoute：GatewayRoute
type GatewayRoute interface {
	Resolve(role string) *GatewayResolution
}

// RoutedRegistryOptions：RoutedRegistryOptions
type RoutedRegistryOptions struct {
	Store        *Store
	Gateway      GatewayRoute
	EnvProviders []blm.LLMProvider
	Factory      ProviderFactory
	OverrideID   string
	OnError      func(msg string, err error)
	OnCall       func(e *u.Obj)
}

// ResolvedProvider：{ provider, model? }
type ResolvedProvider struct {
	Provider blm.LLMProvider
	Model    *string
}

type orderedProviders struct {
	keys []string
	m    map[string]blm.LLMProvider
}

func newOrdered() *orderedProviders { return &orderedProviders{m: map[string]blm.LLMProvider{}} }
func (o *orderedProviders) set(k string, p blm.LLMProvider) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = p
}
func (o *orderedProviders) values() []blm.LLMProvider {
	out := make([]blm.LLMProvider, 0, len(o.keys))
	for _, k := range o.keys {
		out = append(out, o.m[k])
	}
	return out
}

// RoutedLLMRegistry：RoutedLLMRegistry
type RoutedLLMRegistry struct {
	opts        RoutedRegistryOptions
	mu          sync.Mutex
	env, extra  *orderedProviders
	stored      *orderedProviders
	unsubscribe func()
	sink        *UsageSink
	gwSig       string
	gwProvider  blm.LLMProvider
}

// NewRoutedLLMRegistry：new RoutedLLMRegistry(opts)
func NewRoutedLLMRegistry(opts RoutedRegistryOptions) *RoutedLLMRegistry {
	r := &RoutedLLMRegistry{opts: opts, env: newOrdered(), extra: newOrdered(), stored: newOrdered()}
	if st := opts.Store; st != nil {
		r.sink = &UsageSink{
			RecordUsage: func(id string, us *u.Obj, ok bool) {
				var v any = u.Undefined
				if us != nil {
					v = us
				}
				st.RecordUsage(id, v, ok)
			},
			MarkKey: func(id string, i int, e *string) {
				var v any = u.Undefined
				if e != nil {
					v = *e
				}
				st.MarkKey(id, float64(i), v)
			},
			RecordCall: func(e *u.Obj) { st.RecordCall(e) },
		}
		if opts.OnCall != nil {
			r.sink.LogCall = opts.OnCall
		}
	}
	for _, p := range opts.EnvProviders {
		if r.sink != nil {
			tp, _ := NewTrackedProvider(p.ProviderID(), []blm.LLMProvider{p}, r.sink, "", nil)
			r.env.set(p.ProviderID(), tp)
		} else {
			r.env.set(p.ProviderID(), p)
		}
	}
	if opts.Store != nil {
		r.Rebuild()
		r.unsubscribe = opts.Store.OnChange(r.Rebuild)
	}
	return r
}

// Dispose：dispose()
func (r *RoutedLLMRegistry) Dispose() {
	if r.unsubscribe != nil {
		r.unsubscribe()
	}
}

func (r *RoutedLLMRegistry) factory() ProviderFactory {
	if r.opts.Factory != nil {
		return r.opts.Factory
	}
	return DefaultProviderFactory
}

// Rebuild：rebuild()
func (r *RoutedLLMRegistry) Rebuild() {
	st := r.opts.Store
	if st == nil {
		return
	}
	next := newOrdered()
	for _, p := range st.Providers() {
		if !truthy(p.Get("enabled")) {
			continue
		}
		id := jsString(p.Get("id"))
		keys, err := st.ResolveKeys(id)
		var tp *TrackedProvider
		if err == nil {
			tp, err = BuildStoredProvider(p, keys, r.factory(), r.sink)
		}
		if err != nil {
			if r.opts.OnError != nil {
				r.opts.OnError("build provider "+id+" failed", err)
			}
			continue
		}
		next.set(id, tp)
	}
	r.mu.Lock()
	r.stored = next
	r.mu.Unlock()
}

// Register：register(provider)
func (r *RoutedLLMRegistry) Register(p blm.LLMProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.extra.set(p.ProviderID(), p)
}

// Get：get(id)
func (r *RoutedLLMRegistry) Get(id string) blm.LLMProvider {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.getLocked(id)
}

func (r *RoutedLLMRegistry) getLocked(id string) blm.LLMProvider {
	if p, ok := r.stored.m[id]; ok {
		return p
	}
	if p, ok := r.env.m[id]; ok {
		return p
	}
	if p, ok := r.extra.m[id]; ok {
		return p
	}
	return nil
}

// List：list()
func (r *RoutedLLMRegistry) List() []blm.LLMProvider {
	var first blm.LLMProvider
	if res := r.ResolveProvider("chat"); res != nil {
		first = res.Provider
	}
	r.mu.Lock()
	all := append(append(r.stored.values(), r.env.values()...), r.extra.values()...)
	r.mu.Unlock()
	if first == nil {
		return all
	}
	out := []blm.LLMProvider{first}
	for _, p := range all {
		if p != first {
			out = append(out, p)
		}
	}
	return out
}

// EnvIDs：envIds()
func (r *RoutedLLMRegistry) EnvIDs() []string { return append([]string{}, r.env.keys...) }

func (r *RoutedLLMRegistry) gatewayProvider(g *GatewayResolution) (blm.LLMProvider, error) {
	sig := g.BaseURL + "|" + g.Token + "|" + g.Protocol + "|" + g.Receiver.ID + "|" + g.Receiver.BaseURL
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gwProvider != nil && r.gwSig == sig {
		return r.gwProvider, nil
	}
	recv := g.Receiver
	p, err := r.factory()(aisdk.Options{ID: GatewayProviderID, Protocol: g.Protocol, BaseURL: g.BaseURL, FullURL: boolPtr(false),
		DefaultModel: g.Model, APIKey: g.Token, RequiresAPIKey: boolPtr(true), Receiver: &recv, Client: g.Client,
		ServedModelHeader: NomiServedModelHeader, RedactedHeader: NomiRedactedHeader})
	if err != nil {
		return nil, err
	}
	tp, _ := NewTrackedProvider(GatewayProviderID, []blm.LLMProvider{p}, r.sink, g.Model, nil)
	r.gwSig, r.gwProvider = sig, tp
	return tp, nil
}

// ResolveProvider：resolve(role)；nil = undefined。网关 provider 构造抛错时 panic 同 Node 抛出
func (r *RoutedLLMRegistry) ResolveProvider(role string) *ResolvedProvider {
	if role == "" {
		role = "chat"
	}
	if r.opts.OverrideID != "" {
		if p := r.Get(r.opts.OverrideID); p != nil {
			return &ResolvedProvider{Provider: p}
		}
	}
	if r.opts.Gateway != nil {
		if g := r.opts.Gateway.Resolve(role); g != nil {
			p, err := r.gatewayProvider(g)
			if err != nil {
				panic(err)
			}
			m := g.Model
			return &ResolvedProvider{Provider: p, Model: &m}
		}
		return nil
	}
	if st := r.opts.Store; st != nil {
		route, _ := st.Route(role).(*u.Obj)
		if route != nil {
			if p := r.Get(jsString(route.Get("providerId"))); p != nil {
				res := &ResolvedProvider{Provider: p}
				if m, ok := route.Get("model").(string); ok {
					res.Model = &m
				}
				return res
			}
		}
		if id := st.ActiveProviderID(); truthy(id) {
			if p := r.Get(jsString(id)); p != nil {
				return &ResolvedProvider{Provider: p}
			}
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if fb := append(r.env.values(), r.extra.values()...); len(fb) > 0 {
		return &ResolvedProvider{Provider: fb[0]}
	}
	return nil
}

// Resolve：RoutedRegistry（ProviderService 用的子集）
func (r *RoutedLLMRegistry) Resolve(role string) (Resolved, bool) {
	res := r.ResolveProvider(role)
	if res == nil {
		return Resolved{}, false
	}
	return Resolved{ProviderID: res.Provider.ProviderID(), Model: res.Model}, true
}
