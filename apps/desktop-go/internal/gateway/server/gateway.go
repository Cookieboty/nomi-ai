package server

// gateway.go is server.ts: the GatewayServer (HTTP entry, identify, proxy main
// flow with candidates / learning / cooldowns / affinity / privacy / trace,
// attempt, respond, count_tokens). Layering and names follow server.ts 1:1.

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"math"
	gonet "net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/cand"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/canonical"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/clients"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	gerr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/errors"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/intent"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models/rules/request"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/privacy"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/providers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/stream/events"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	GatewayVersion    = "1"
	MaxAttempts       = 4
	MaxLearnRetries   = 2
	ServedModelHeader = "x-nomi-served-model"
	RedactedHeader    = "x-nomi-redacted"
	// TraceIDHeader is TRACE_ID_HEADER (§8.3).
	TraceIDHeader = "x-nomi-trace-id"
	// CommitKeepaliveMs is COMMIT_KEEPALIVE_MS (§6.11.2).
	CommitKeepaliveMs = 3_000
)

// Logger is GatewayHooks.logger.
type Logger interface {
	Info(msg string, d any)
	Warn(msg string, d any)
}

// GatewayHooks is GatewayHooks. Usage events are the JS UsageEvent objects
// (ordered keys, same shape as onUsage receives in Node).
type GatewayHooks struct {
	OnUsage     func(e *u.Obj)
	OnLearn     func(e LearnEvent)
	OnKeyStatus func(e upstream.KeyStatusEvent)
	Logger      Logger
	// FetchImpl overrides the pinned upstream fetch (tests).
	FetchImpl func(req *http.Request) (*http.Response, error)
	LookupAll gwnet.LookupAll
	upstream.TimeoutHooks
	Now           func() float64
	Bindings      *route.BindingTable
	BindingWaitMs *int
}

func tokenEquals(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// ---------------------------------------------------------------------------
// response writer: the subset of http.ServerResponse server.ts uses

type gwRes struct {
	mu          sync.Mutex
	w           http.ResponseWriter
	ctx         context.Context
	headersSent bool
	finished    atomic.Bool
	trace       *RequestTrace
	req         *http.Request
}

func (r *gwRes) destroyed() bool { return r.ctx.Err() != nil && !r.finished.Load() }

func (r *gwRes) setHeader(name, v string) { r.w.Header()[name] = []string{v} }

func (r *gwRes) writeHeadLocked(status int, kv []string) {
	for i := 0; i+1 < len(kv); i += 2 {
		r.w.Header()[kv[i]] = []string{kv[i+1]}
	}
	r.headersSent = true
	r.nodeHead()
	r.w.WriteHeader(status)
	// Node's writeHead puts the head on the wire without a Content-Length unless
	// one was given, so the body that follows is chunked; flush to match.
	hasCL := false
	for i := 0; i+1 < len(kv); i += 2 {
		hasCL = hasCL || strings.EqualFold(kv[i], "Content-Length")
	}
	if !hasCL {
		if f, ok := r.w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

// nodeHead adds what Node's http.ServerResponse puts on the wire by itself and
// stops net/http from adding what Node would not. Node always sends Date (sendDate
// defaults to true, server.ts does not turn it off), so Go's Date stays. When the
// handler set no Connection header and the request keeps the socket alive, Node
// sends `Connection: keep-alive` plus `Keep-Alive: timeout=5`; for a closing
// request net/http writes `Connection: close` the same way Node does. Node never
// sniffs a Content-Type, so a nil entry suppresses Go's sniffing.
func (r *gwRes) nodeHead() {
	h := r.w.Header()
	has := func(k string) bool {
		for n := range h {
			if strings.EqualFold(n, k) {
				return true
			}
		}
		return false
	}
	if !has("Content-Type") {
		h["Content-Type"] = nil
	}
	if !has("Connection") && r.req != nil && !r.req.Close {
		h["Connection"] = []string{"keep-alive"}
		h["Keep-Alive"] = []string{"timeout=5"}
	}
}

func (r *gwRes) writeHead(status int, kv ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeHeadLocked(status, kv)
}

func (r *gwRes) writeLocked(s string) {
	if r.trace != nil {
		r.trace.Client(s)
	}
	if r.finished.Load() || r.destroyed() {
		return
	}
	if !r.headersSent {
		r.headersSent = true
		r.nodeHead()
		r.w.WriteHeader(200)
	}
	if s != "" {
		_, _ = io.WriteString(r.w, s)
	}
	if f, ok := r.w.(http.Flusher); ok {
		f.Flush()
	}
}

func (r *gwRes) write(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeLocked(s)
}

func (r *gwRes) end(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.finished.Load() {
		return
	}
	if r.trace != nil {
		r.trace.Client(s)
	}
	if !r.destroyed() {
		if !r.headersSent {
			r.headersSent = true
			r.w.WriteHeader(200)
		}
		if s != "" {
			_, _ = io.WriteString(r.w, s)
		}
	}
	r.finished.Store(true)
}

func (r *gwRes) sent() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.headersSent
}

// sendJSON is sendJson: extra headers, then Content-Type, then Content-Length.
func sendJSON(res *gwRes, status int, body any, extra ...string) {
	data := u.Stringify(body)
	kv := append(append([]string{}, extra...), "Content-Type", "application/json", "Content-Length", strconv.Itoa(len(data)))
	res.mu.Lock()
	res.writeHeadLocked(status, kv)
	res.mu.Unlock()
	res.end(data)
}

// BodyTooLargeError is BodyTooLargeError.
type BodyTooLargeError struct{ MaxBytes int }

func (e *BodyTooLargeError) Error() string {
	return "请求体超过上限（" + strconv.Itoa(e.MaxBytes) + " 字节）"
}

var errBadJSON = errors.New("bad json")

// readBody is readBody: Content-Length precheck, streaming cap, "" → {}.
func readBody(req *http.Request, maxBytes int) (any, error) {
	if cl, ok := u.NodeHeader(req.Header, "content-length"); ok {
		if n, ok := u.ToNumber(cl), true; ok && !math.IsInf(n, 0) && !math.IsNaN(n) && n > float64(maxBytes) {
			go func() { _, _ = io.Copy(io.Discard, req.Body) }()
			return nil, &BodyTooLargeError{maxBytes}
		}
	}
	var buf bytes.Buffer
	_, err := io.Copy(&buf, io.LimitReader(req.Body, int64(maxBytes)+1))
	if buf.Len() > maxBytes {
		go func() { _, _ = io.Copy(io.Discard, req.Body) }()
		return nil, &BodyTooLargeError{maxBytes}
	}
	if err != nil {
		return nil, err
	}
	var d u.TextDecoder
	raw := d.Decode(buf.Bytes()) + d.Flush()
	if raw == "" {
		return u.NewObj(), nil
	}
	v, err := u.ParseString(raw)
	if err != nil {
		return nil, errBadJSON
	}
	return v, nil
}

var bearerRe = regexp.MustCompile(`(?i)^Bearer\s+`)

func presentedTokens(req *http.Request, q url.Values) []string {
	var out []string
	if x, ok := u.NodeHeader(req.Header, "x-api-key"); ok && x != "" {
		out = append(out, x)
	}
	if a, ok := u.NodeHeader(req.Header, "authorization"); ok && a != "" {
		out = append(out, bearerRe.ReplaceAllString(a, ""))
	}
	if g, ok := u.NodeHeader(req.Header, "x-goog-api-key"); ok && g != "" {
		out = append(out, g)
	}
	if v := q["key"]; len(v) > 0 && v[0] != "" {
		out = append(out, v[0])
	}
	return out
}

func legacyClient(ingress *upstream.Ingress, ua string) string {
	w := ""
	if ingress != nil {
		w = ingress.Wire
	}
	return clients.LegacyClientOf(w, ua)
}

// Identity is Identity.
type Identity struct {
	Client  string
	Binding *route.TabBinding
}

// attemptT is Attempt (kind "response" | "failed").
type attemptT struct {
	kind      string
	res       *Resp
	cand      *cand.Candidate
	notes     []string
	stage     *providers.Stage
	headersAt *float64

	status         int
	message        string
	retryable      bool
	text           *string
	sent           any
	upstreamStatus *int
	network        bool
	retryAfter     *string
	outcome        string // "" = undefined
	errorKind      string // "" = undefined
}

// responded is Responded.
type responded struct {
	usage          events.StreamUsage
	outcome        string
	errorKind      string
	cancelPhase    string
	firstContentAt *float64
	firstTextAt    *float64
	lastContentAt  *float64
	streamed       bool
}

// GatewayServer is GatewayServer.
type GatewayServer struct {
	mu      sync.Mutex
	cfg     *config.GatewayConfig
	hooks   GatewayHooks
	srv     *http.Server
	ln      gonet.Listener
	learner *Learner
	cool    *upstream.Cooldowns
	// Bindings is the tab token table (§6.7).
	Bindings *route.BindingTable
	limiter  *upstream.Limiter
	affinity *Affinity
	sessions *SessionTable
	// Metrics is the in-process RoutePlan metrics (GET /metrics).
	Metrics       *GatewayMetrics
	upstreamFetch gwnet.UpstreamFetch
	privacy       *privacy.GatewayPrivacy
}

// NewGatewayServer is new GatewayServer(cfg, hooks).
func NewGatewayServer(cfg *config.GatewayConfig, hooks GatewayHooks) *GatewayServer {
	g := &GatewayServer{cfg: cfg, hooks: hooks, privacy: privacy.NewGatewayPrivacy()}
	now := hooks.Now
	if now == nil {
		now = NowMs
	}
	g.limiter = upstream.NewLimiter(now)
	g.Bindings = hooks.Bindings
	if g.Bindings == nil {
		g.Bindings = route.NewBindingTable()
	}
	g.cool = upstream.NewCooldowns(func(e upstream.KeyStatusEvent) {
		if g.hooks.Logger != nil {
			g.hooks.Logger.Info("gateway key status", e.JSON())
		}
		if g.hooks.OnKeyStatus != nil {
			g.hooks.OnKeyStatus(e)
		}
	}, now)
	g.affinity = NewAffinity(now, 0, 0)
	g.sessions = NewSessionTable(cfg.SessionsFile, now)
	g.learner = NewLearner(func(e LearnEvent) {
		if g.hooks.Logger != nil {
			g.hooks.Logger.Info("gateway learned", e.Obj())
		}
		if g.hooks.OnLearn != nil {
			g.hooks.OnLearn(e)
		}
	}, nil)
	g.Metrics = NewGatewayMetrics(MetricsOptions{Now: now})
	g.privacy.Configure(cfg)
	g.upstreamFetch = gwnet.CreateUpstreamFetch(gwnet.FetchOptions{GetGuard: func() gwnet.GuardOpts {
		c := g.Config()
		port := c.Port
		if a := g.Address(); a != nil {
			port = a.Port
		}
		return gwnet.GuardOpts{AllowedPrivateHosts: c.AllowedPrivateHosts, SelfPort: port, LookupAll: g.hooks.LookupAll}
	}})
	return g
}

// CreateGateway is createGateway.
func CreateGateway(cfg *config.GatewayConfig, hooks GatewayHooks) *GatewayServer {
	return NewGatewayServer(cfg, hooks)
}

func (g *GatewayServer) doFetch(req *http.Request) (*http.Response, error) {
	if g.hooks.FetchImpl != nil {
		return g.hooks.FetchImpl(req)
	}
	return g.upstreamFetch(req)
}

// Update swaps the config; in-flight requests keep their snapshot.
func (g *GatewayServer) Update(cfg *config.GatewayConfig) {
	g.mu.Lock()
	g.cfg = cfg
	g.mu.Unlock()
	g.privacy.Configure(cfg)
}

// Config is the config getter.
func (g *GatewayServer) Config() *config.GatewayConfig {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.cfg
}

// Start is start(): listen on cfg.host:cfg.port.
func (g *GatewayServer) Start() error {
	g.mu.Lock()
	if g.ln != nil {
		g.mu.Unlock()
		return nil
	}
	cfg := g.cfg
	g.mu.Unlock()
	ln, err := gonet.Listen("tcp", gonet.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	// Node http.Server defaults: keepAliveTimeout 5000ms (advertised as Keep-Alive: timeout=5).
	srv := &http.Server{Handler: g, IdleTimeout: 5 * time.Second}
	g.mu.Lock()
	g.ln, g.srv = ln, srv
	g.mu.Unlock()
	go func() { _ = srv.Serve(ln) }()
	if g.hooks.Logger != nil {
		g.hooks.Logger.Info("gateway listening", g.ListenURL())
	}
	return nil
}

// Stop is stop(): flush sessions, close the server and every socket.
func (g *GatewayServer) Stop() {
	g.sessions.Flush()
	g.mu.Lock()
	s := g.srv
	g.srv, g.ln = nil, nil
	g.mu.Unlock()
	if s != nil {
		_ = s.Close()
	}
}

// Address is address(): nil when not listening.
func (g *GatewayServer) Address() *gonet.TCPAddr {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln == nil {
		return nil
	}
	a, _ := g.ln.Addr().(*gonet.TCPAddr)
	return a
}

// ListenURL is listenUrl(); "" = null.
func (g *GatewayServer) ListenURL() string {
	a := g.Address()
	if a == nil {
		return ""
	}
	return "http://" + gwnet.URLHost(g.Config().Host) + ":" + strconv.Itoa(a.Port)
}

func clientIDs(cfg *config.GatewayConfig) []string {
	if cfg.ClientOrder != nil {
		return cfg.ClientOrder
	}
	ids := make([]string, 0, len(cfg.Clients))
	for id := range cfg.Clients {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// identify: client token, tab token (§6.7), legacy token. unbound=true → 503.
func (g *GatewayServer) identify(cfg *config.GatewayConfig, req *http.Request, q url.Values) (who *Identity, unbound bool) {
	tokens := presentedTokens(req, q)
	for _, id := range clientIDs(cfg) {
		c := cfg.Clients[id]
		if c == nil || c.Token == "" {
			continue
		}
		for _, x := range tokens {
			if tokenEquals(x, c.Token) {
				if clients.ClientSpecOf(id) != nil {
					return &Identity{Client: id}, false
				}
				return nil, false
			}
		}
	}
	for _, tab := range tokens {
		if !route.IsTabToken(tab) {
			continue
		}
		b := g.Bindings.Get(route.HashTabToken(tab))
		if b == nil {
			wait := route.BindingWaitMs
			if g.hooks.BindingWaitMs != nil {
				wait = *g.hooks.BindingWaitMs
			}
			b = g.Bindings.Lookup(tab, wait)
		}
		if b == nil {
			return nil, true
		}
		if clients.ClientSpecOf(b.Client) != nil {
			return &Identity{Client: b.Client, Binding: b}, false
		}
		return nil, false
	}
	if cfg.LegacyToken != "" {
		for _, x := range tokens {
			if tokenEquals(x, cfg.LegacyToken) {
				return &Identity{Client: "legacy"}, false
			}
		}
	}
	return nil, false
}

var modelsPathRe = regexp.MustCompile(`/models/?$`)

// pathnameOf is WHATWG `new URL(req.url, 'http://127.0.0.1').pathname`
// (percent-encoding kept, dot segments removed).
func pathnameOf(raw string) (string, url.Values) {
	p, q := raw, ""
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		p = raw[:i]
		if raw[i] == '?' {
			q = raw[i+1:]
			if j := strings.IndexByte(q, '#'); j >= 0 {
				q = q[:j]
			}
		}
	}
	p = strings.ReplaceAll(p, "\\", "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	segs := strings.Split(p[1:], "/")
	var out []string
	for i, s := range segs {
		ls := strings.ToLower(s)
		last := i == len(segs)-1
		switch ls {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	vals, _ := url.ParseQuery(q)
	return "/" + strings.Join(out, "/"), vals
}

// ServeHTTP is handle(req, res).
func (g *GatewayServer) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	res := &gwRes{w: w, ctx: req.Context(), req: req}
	g.handle(req, res)
}

func (g *GatewayServer) handle(req *http.Request, res *gwRes) {
	cfg := g.Config()
	port := cfg.Port
	if a := g.Address(); a != nil {
		port = a.Port
	}
	if !gwnet.IsAllowedHostHeader(req.Host, port) {
		sendJSON(res, 421, u.NewObj("error", "misdirected request: invalid Host header"))
		return
	}
	pathname, q := pathnameOf(req.RequestURI)
	if req.Method == "GET" && (pathname == "/health" || pathname == "/") {
		sendJSON(res, 200, u.NewObj("ok", true, "service", "nomi-gateway", "version", GatewayVersion))
		return
	}
	if req.Method == "GET" && pathname == "/metrics" {
		sendJSON(res, 200, g.Metrics.Snapshot())
		return
	}
	if o, _ := u.NodeHeader(req.Header, "origin"); o != "" {
		sendJSON(res, 403, u.NewObj("error", "browser requests are not allowed"))
		return
	}
	ingress := upstream.IngressFromPath(pathname)
	wire := "chat"
	if ingress != nil {
		wire = ingress.Wire
	}
	who, unbound := g.identify(cfg, req, q)
	if unbound {
		st, b := gerr.ErrorResponse(wire, "overloaded", "Nomi 网关：这个标签的会话还没准备好，请稍后重试")
		sendJSON(res, st, b, "Retry-After", strconv.Itoa(route.BindingRetryAfterS))
		return
	}
	if who == nil {
		st, b := gerr.ErrorResponse(wire, "auth", "Nomi 网关：缺少或错误的客户端令牌（请在 Nomi 里重新打开这个标签）")
		sendJSON(res, st, b)
		return
	}
	if req.Method == "GET" && modelsPathRe.MatchString(pathname) {
		format := "openai"
		xk, _ := u.NodeHeader(req.Header, "x-api-key")
		au, _ := u.NodeHeader(req.Header, "authorization")
		if strings.HasPrefix(pathname, "/v1beta") {
			format = "gemini"
		} else if xk != "" && au == "" {
			format = "anthropic"
		}
		sendJSON(res, 200, models.ModelsBody(cfg, format))
		return
	}
	if req.Method != "POST" || ingress == nil {
		sendJSON(res, 404, u.NewObj("error", "unknown route: "+req.Method+" "+pathname))
		return
	}
	g.proxy(req, res, cfg, who.Client, ingress, who.Binding)
}

// SSE headers.
var sseHeaders = []string{"Content-Type", "text/event-stream; charset=utf-8", "Cache-Control", "no-cache", "Connection", "keep-alive"}

func strp(s string) *string { return &s }
func fp(f float64) *float64 { return &f }
func ip(i int) *int         { return &i }

func usageObj(s events.StreamUsage) *u.Obj {
	o := u.NewObj()
	for _, kv := range []struct {
		k string
		v *float64
	}{{"inputTokens", s.InputTokens}, {"outputTokens", s.OutputTokens}, {"cacheReadTokens", s.CacheReadTokens}, {"cacheWriteTokens", s.CacheWriteTokens}, {"reasoningTokens", s.ReasoningTokens}} {
		if kv.v != nil {
			o.Set(kv.k, *kv.v)
		}
	}
	return o
}

func qaObj(a QualityAttempt) *u.Obj {
	o := u.NewObj("provider", a.Provider)
	if a.KeyID != nil {
		o.Set("keyId", *a.KeyID)
	}
	o.Set("model", a.Model)
	if a.UpstreamWire != nil {
		o.Set("upstreamWire", *a.UpstreamWire)
	}
	if a.Status != nil {
		o.Set("status", float64(*a.Status))
	}
	o.Set("outcome", a.Outcome)
	o.Set("ms", a.Ms)
	if a.HeadersMs != nil {
		o.Set("headersMs", *a.HeadersMs)
	}
	if a.ErrorKind != nil {
		o.Set("errorKind", *a.ErrorKind)
	}
	return o
}

func jsDecodeAll(c Chunks) (string, error) {
	var d u.TextDecoder
	var sb strings.Builder
	if c == nil {
		return "", nil
	}
	for {
		b, err := c.Next()
		if len(b) > 0 {
			sb.WriteString(d.Decode(b))
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
	}
	sb.WriteString(d.Flush())
	return sb.String(), nil
}

// fetchErrMessage is the message of the error undici's fetch rejects with.
func fetchErrMessage(ctx context.Context) string {
	if ctx.Err() != nil {
		return "This operation was aborted"
	}
	return "fetch failed"
}

// bodyErrMessage is the message of a rejected body read.
func bodyErrMessage(ctx context.Context) string {
	if ctx.Err() != nil {
		return "This operation was aborted"
	}
	return "terminated"
}

func headerGet(h http.Header, name string) *string {
	v := h.Values(name)
	if len(v) == 0 {
		return nil
	}
	s := strings.Join(v, ", ")
	return &s
}

// nodeHeaders is req.headers as a plain object (lowercase names).
func nodeHeaders(h http.Header) map[string]any {
	out := map[string]any{}
	for k := range h {
		lk := strings.ToLower(k)
		if lk == "set-cookie" {
			out[lk] = append([]string(nil), h[k]...)
			continue
		}
		if v, ok := u.NodeHeader(h, lk); ok {
			out[lk] = v
		}
	}
	return out
}

func nodeHeaderObj(req *http.Request) *u.Obj {
	h := nodeHeaders(req.Header)
	if req.Host != "" {
		h["host"] = req.Host
	}
	keys := make([]string, 0, len(h))
	for k := range h {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	o := u.NewObj()
	for _, k := range keys {
		switch v := h[k].(type) {
		case []string:
			a := make([]any, len(v))
			for i, s := range v {
				a[i] = s
			}
			o.Set(k, a)
		default:
			o.Set(k, v)
		}
	}
	return o
}

func (g *GatewayServer) proxy(req *http.Request, res *gwRes, cfg *config.GatewayConfig, client string, ingress *upstream.Ingress, binding *route.TabBinding) {
	startedAt := NowMs()
	tag := u.NewObj()
	if binding != nil {
		tag.Set("tabId", binding.TabID)
		tag.Set("generation", binding.Generation)
	}
	sseOpen := false
	fail := func(status int, message string, retryAfter *string) {
		st, b := gerr.ErrorResponse(ingress.Wire, gerr.KindOfStatus(status, message), message)
		if !res.sent() {
			if retryAfter != nil {
				sendJSON(res, st, b, "Retry-After", *retryAfter)
			} else {
				sendJSON(res, st, b)
			}
		} else if sseOpen && !res.destroyed() {
			res.end(sseFailure(ingress.Wire, message))
		} else {
			res.end("")
		}
	}
	var kaMu sync.Mutex
	keepAliveClient := client
	keepAlive := func() {
		kaMu.Lock()
		kc := keepAliveClient
		kaMu.Unlock()
		if kc == "nomi" {
			return
		}
		res.mu.Lock()
		defer res.mu.Unlock()
		if res.headersSent || res.destroyed() {
			return
		}
		res.writeHeadLocked(200, sseHeaders)
		res.writeLocked(": keepalive\n\n")
		sseOpen = true
	}
	reported := false
	var resolvedCands []*cand.Candidate
	var winCand *cand.Candidate
	report := func(e *u.Obj) {
		if reported {
			return
		}
		reported = true
		ms := NowMs() - startedAt
		var plan *cand.RoutePlan
		if winCand != nil {
			plan = winCand.Plan
		} else if len(resolvedCands) > 0 {
			plan = resolvedCands[0].Plan
		}
		ev := u.NewObj("client", client, "ingress", ingress.Wire, "startedAt", startedAt, "ms", ms)
		for _, k := range e.Keys() {
			ev.Set(k, e.Get(k))
		}
		timing := u.NewObj()
		if t, ok := e.Get("timing").(*u.Obj); ok {
			timing = t.Clone()
		}
		timing.Set("endMs", ms)
		ev.Set("timing", timing)
		for _, k := range tag.Keys() {
			ev.Set(k, tag.Get(k))
		}
		var losses []string
		if plan != nil {
			ev.Set("routeQuality", plan.Quality)
			if len(plan.Losses) > 0 {
				a := make([]any, len(plan.Losses))
				for i, l := range plan.Losses {
					a[i] = l
				}
				ev.Set("losses", a)
				losses = plan.Losses
			}
		}
		str := func(k string) string { s, _ := ev.Get(k).(string); return s }
		mo := MetricsObserve{Client: client, Ingress: ingress.Wire, E2eMs: fp(ms)}
		if w := str("wire"); w != "" {
			mo.Upstream, mo.UpstreamWire = w, w
		}
		if plan != nil {
			mo.RouteQuality = plan.Quality
		}
		mo.Losses = losses
		if v, ok := timing.Get("firstContentMs").(float64); ok {
			mo.TtftMs = fp(v)
		}
		mo.Provider, mo.KeyID, mo.Outcome = str("provider"), str("keyId"), str("outcome")
		g.Metrics.Observe(mo)
		if ad, ok := ev.Get("attemptsDetail").([]any); ok {
			for _, x := range ad {
				a, _ := x.(*u.Obj)
				if a == nil {
					continue
				}
				ap, _ := a.Get("provider").(string)
				ak, _ := a.Get("keyId").(string)
				aw, _ := a.Get("upstreamWire").(string)
				ao, _ := a.Get("outcome").(string)
				if ap == "" || ak == "" || aw == "" {
					continue
				}
				if mo.Provider == ap && mo.KeyID == ak && str("wire") == aw && ao == mo.Outcome {
					continue
				}
				g.Metrics.RecordHealth(HealthSample{Provider: ap, KeyID: ak, Wire: aw, OK: ao == "ok", AuthLimited: ao == "auth" || ao == "rate-limit"})
			}
		}
		if g.hooks.OnUsage != nil {
			g.hooks.OnUsage(ev)
		}
	}
	reportLocal := func(status int, message string) {
		outcome := "gateway-error"
		if status >= 400 && status < 500 {
			outcome = "request-rejected"
		}
		report(u.NewObj("status", float64(status), "usage", u.NewObj(), "attempts", 0.0, "error", message,
			"outcome", outcome, "timing", u.NewObj("endMs", 0.0), "attemptsDetail", []any{}, "stream", false))
	}
	maxBody := config.ClampMaxRequestBodyBytes(cfg.MaxRequestBodyBytes)
	body, err := readBody(req, maxBody)
	if err != nil {
		var tl *BodyTooLargeError
		if errors.As(err, &tl) {
			message := "Nomi 网关：请求体超过上限（最大 " + strconv.Itoa(maxBody) + " 字节）"
			fail(413, message, nil)
			reportLocal(413, message)
			return
		}
		message := "Nomi 网关：请求体不是合法的 JSON"
		fail(400, message, nil)
		reportLocal(400, message)
		return
	}
	var tl WarnLogger
	if g.hooks.Logger != nil {
		tl = g.hooks.Logger
	}
	trace := StartTrace(cfg, TraceMeta{Client: client, Ingress: ingress.Wire, Path: req.RequestURI, StartedAt: startedAt}, tl)
	if trace != nil {
		trace.Request(nodeHeaderObj(req), body, true)
		res.setHeader(TraceIDHeader, trace.ID)
		res.trace = trace
	}
	b, _ := body.(*u.Obj)
	if b == nil {
		b = u.NewObj()
	}
	requested := ""
	if ingress.Wire == "gemini" {
		if ingress.Model != nil {
			requested = *ingress.Model
		}
	} else if s, ok := b.Get("model").(string); ok {
		requested = s
	}
	resolveAs := client
	if client == "legacy" {
		ua, _ := u.NodeHeader(req.Header, "user-agent")
		resolveAs = legacyClient(ingress, ua)
	}
	kaMu.Lock()
	if resolveAs != "" {
		keepAliveClient = resolveAs
	} else {
		keepAliveClient = client
	}
	kaMu.Unlock()
	var bm *config.ClientModels
	if binding != nil {
		bm = binding.Models
	}
	r := route.ResolveCandidates(cfg, resolveAs, requested, ingress.Wire, bm)
	if !r.OK {
		fail(r.Status, r.Message, nil)
		reportLocal(r.Status, r.Message)
		return
	}
	if r.Resolution != nil {
		tag.Set("resolved", r.Resolution.How)
	}
	resolvedCands = r.Candidates
	if len(r.Candidates) > 0 {
		if plan := r.Candidates[0].Plan; plan != nil && plan.Legacy != "" && plan.Legacy != plan.Upstream && g.hooks.Logger != nil {
			ls := make([]any, len(plan.Losses))
			for i, l := range plan.Losses {
				ls[i] = l
			}
			why := make([]any, len(plan.Why))
			for i, l := range plan.Why {
				why[i] = l
			}
			g.hooks.Logger.Info("gateway route plan (shadow) differs", u.NewObj("model", r.Candidates[0].PublicModel,
				"ingress", ingress.Wire, "current", plan.Legacy, "planned", plan.Upstream, "why", why, "losses", ls))
		}
	}
	var resolveNotes []string
	if r.Resolution != nil && r.Resolution.Note != "" {
		resolveNotes = []string{r.Resolution.Note}
	}
	wantsStream := ingress.Stream
	if ingress.Wire != "gemini" {
		wantsStream = b.Get("stream") == true
	}
	in := intent.ReadIntent(ingress.Wire, body, resolveAs)
	quality := u.NewObj("stream", wantsStream)
	if in != nil {
		quality.Set("reasoning", in.Mode != "disabled")
	}
	var masked *privacy.MaskResult
	ensureMasked := func() (int, string, bool) {
		if masked != nil {
			return 0, "", false
		}
		var m privacy.MaskResult
		var perr any
		func() {
			defer func() { perr = recover() }()
			m = g.privacy.Mask(cfg, body)
		}()
		if perr != nil {
			if g.hooks.Logger != nil {
				msg := ""
				if e, ok := perr.(error); ok {
					msg = e.Error()
				} else if s, ok := perr.(string); ok {
					msg = s
				}
				g.hooks.Logger.Warn("gateway privacy mask failed", u.NewObj("error", msg))
			}
			return 500, "Nomi 网关：脱敏出错，请求没有发出", true
		}
		masked = &m
		if len(m.Hits) > 0 {
			tag.Set("redactions", hitsArr(m.Hits, nil))
		}
		if m.Restore != nil && m.Restore.Size() > 0 && trace != nil {
			trace.AddSecrets(m.Restore.Values())
		}
		if m.Blocked {
			var kinds []string
			for _, h := range m.Hits {
				if h.Action == "block" {
					kinds = append(kinds, h.Kind+" ×"+strconv.Itoa(h.Masked))
				}
			}
			tag.Set("blocked", true)
			return 400, "Nomi 网关：请求里有设为拦截的密钥（" + strings.Join(kinds, "、") + "），已按外发保护的设置拦下。可以在 设置 → 隐私与权限 → 外发保护 里改成脱敏。", true
		}
		return 0, "", false
	}
	for _, c := range r.Candidates {
		if g.privacy.Applies(cfg, c) {
			if st, msg, refused := ensureMasked(); refused {
				fail(st, msg, nil)
				reportLocal(st, msg)
				return
			}
			break
		}
	}
	bodyFor := func(c *cand.Candidate) any {
		if masked != nil && g.privacy.Applies(cfg, c) {
			return masked.Body
		}
		return body
	}
	if ingress.CountTokens {
		g.countTokens(res, cfg, ingress, bodyFor(r.Candidates[0]), r.Candidates[0])
		return
	}

	abortCtx, abort := context.WithCancel(context.Background())
	defer abort()
	go func() {
		select {
		case <-req.Context().Done():
			if !res.finished.Load() {
				abort()
			}
		case <-abortCtx.Done():
		}
	}()
	aborted := func() bool { return abortCtx.Err() != nil }
	var errs []string
	attempts := 0
	var last *attemptT
	var committedContentAt *float64
	attemptsDetail := []any{}
	noteFailure := func(f *attemptT, began float64) {
		var c Classified
		if f.outcome != "" {
			c = Classified{Outcome: f.outcome}
			if f.errorKind != "" {
				c.ErrorKind = strp(f.errorKind)
			}
		} else {
			c = ClassifyAttemptFailure(AttemptFailure{Status: f.status, UpstreamStatus: f.upstreamStatus, Network: f.network, Text: f.text, Message: &f.message})
		}
		st := f.status
		if f.upstreamStatus != nil {
			st = *f.upstreamStatus
		}
		attemptsDetail = append(attemptsDetail, qaObj(QualityAttempt{Provider: f.cand.Provider.ID, KeyID: strp(f.cand.Key.ID),
			Model: f.cand.PublicModel, UpstreamWire: strp(f.cand.Wire), Status: ip(st), Outcome: c.Outcome, Ms: NowMs() - began, ErrorKind: c.ErrorKind}))
	}
	wonAt := startedAt
	var held func()
	session := SessionKey(ingress.Wire, req.Header, body, client, true)
	owner := SessionKey(ingress.Wire, req.Header, body, client, false)
	stripAll := false
	var sticky *AffinityTarget
	if session != "" {
		sticky = g.affinity.Get(session)
	}
	queue := g.ordered(g.withSuppression(cfg, r.Candidates, ingress.Wire), sticky)
	learnRetries := 0
	for len(queue) > 0 && attempts < MaxAttempts {
		if NowMs()-startedAt > upstream.ResolveFirstByteBudgetMs(wantsStream, g.hooks.TimeoutHooks) || aborted() {
			break
		}
		c := queue[0]
		queue = queue[1:]
		peeked := false
		if g.privacy.Applies(cfg, c) {
			if st, msg, refused := ensureMasked(); refused {
				last = &attemptT{kind: "failed", status: st, message: msg, cand: c, outcome: "request-rejected"}
				errs = errs[:0]
				break
			}
		}
		attempts++
		began := NowMs()
		keep := !stripAll && ingress.Wire == c.Wire && g.sessions.CanKeep(owner, c.Provider.ID, c.Key.ID, c.Wire)
		candBody := bodyFor(c)
		sendBody := candBody
		if ingress.Wire == c.Wire && !keep {
			sendBody = StripSealedReasoning(ingress.Wire, candBody)
		}
		ao := upstream.AcquireOpts{Ctx: abortCtx}
		if wantsStream {
			ao.OnWaiting = keepAlive
		}
		release := g.limiter.Acquire(c.Provider.ID+"\u0000"+c.Key.ID, upstream.LimitsOf(c.Provider, c.Key), ao)
		if release == nil {
			oc := "rate-limit"
			if aborted() {
				oc = "client-cancel"
			}
			last = &attemptT{kind: "failed", status: 429, message: "这个 Key 的并发 / 每分钟请求数已满，排队超时", retryable: true, cand: c, outcome: oc, errorKind: "local-limit"}
			noteFailure(last, began)
			kn := keyName(c)
			errs = append(errs, c.Provider.Name+"·"+kn+": "+last.message)
			continue
		}
		var effort *string
		if binding != nil {
			effort = binding.Effort
		}
		last = g.attempt(cfg, resolveAs, req, ingress, c, sendBody, wantsStream, abortCtx, trace, effort)
		if last.kind == "response" && wantsStream && isSseResponse(last.res) {
			got := *last
			{
				spec := providers.SpecOf(c.Provider, c.Wire)
				if providers.StageNeeded(spec) {
					stage := providers.NewStage(spec, c.Wire)
					status := got.res.Status
					var onRaw func(string)
					if trace != nil {
						onRaw = func(t string) { trace.Response(status, t) }
					}
					got.res = stagedResp(got.res, stage, onRaw)
					got.stage = stage
				}
			}
			peek, perr := PeekCommit(got.res, c.Wire, PeekOptions{WaitingMs: fp(CommitKeepaliveMs), OnWaiting: keepAlive})
			if perr != nil {
				peek = PeekResult{Kind: "error", Status: 502, Message: "上游中断（" + bodyErrMessage(abortCtx) + "）"}
			}
			if peek.Kind == "commit" {
				got.res = peek.Res
				last = &got
				committedContentAt = peek.ContentAt
				peeked = true
			} else {
				if trace != nil {
					trace.AttemptResult(200, peek.Message)
				}
				var cl Classified
				if aborted() {
					cl = Classified{Outcome: "client-cancel"}
				} else {
					cl = ClassifyPreCommit(peek.Status, peek.UpstreamStatus)
				}
				f := &attemptT{kind: "failed", status: peek.Status, message: "上游在开始输出前报错：" + peek.Message, retryable: !aborted(), cand: c, outcome: cl.Outcome}
				if peek.UpstreamStatus != nil && *peek.UpstreamStatus != 0 {
					f.upstreamStatus = peek.UpstreamStatus
				}
				if cl.ErrorKind != nil {
					f.errorKind = *cl.ErrorKind
				}
				last = f
			}
		}
		if last.kind != "response" {
			release()
		} else {
			held = release
		}
		if last.kind == "failed" {
			noteFailure(last, began)
		}
		if last.kind == "response" {
			if !peeked {
				committedContentAt = fp(NowMs())
			}
			wonAt = began
			g.learner.Success(c)
			g.cool.Success(c)
			if session != "" {
				g.affinity.Set(session, AffinityTarget{ProviderID: c.Provider.ID, KeyID: c.Key.ID})
			}
			g.sessions.Record(owner, OwnerTarget{ProviderID: c.Provider.ID, KeyID: c.Key.ID, Wire: c.Wire, Model: strp(c.PublicModel)})
			break
		}
		lastStatus := last.status
		if last.upstreamStatus != nil {
			lastStatus = *last.upstreamStatus
		}
		lastText := last.message
		if last.text != nil {
			lastText = *last.text
		}
		if keep && IsReasoningRejection(lastStatus, lastText) && learnRetries < MaxLearnRetries && HasSealedReasoning(ingress.Wire, body) {
			g.sessions.MarkNoKeep(owner)
			stripAll = true
			learnRetries++
			errs = append(errs, c.Provider.Name+"·"+c.Wire+": "+last.message)
			queue = append([]*cand.Candidate{c}, queue...)
			continue
		}
		kn := keyName(c)
		errs = append(errs, c.Provider.Name+"·"+kn+"·"+c.Wire+": "+last.message)
		var ups *float64
		if last.upstreamStatus != nil {
			ups = fp(float64(*last.upstreamStatus))
		}
		if upstream.CoolsDown(last.network, ups) && !aborted() {
			g.cool.Fail(c, upstream.Failure{UpstreamStatus: ups, RetryAfter: last.retryAfter, Message: strp(last.message)})
		}
		var hint *Retry
		if last.text != nil {
			hint = g.learner.Failure(c, ClassifyFailure(last.status, *last.text, last.sent, c.Rectify))
		}
		var retry *cand.Candidate
		if hint != nil && learnRetries < MaxLearnRetries {
			switch {
			case hint.DropParam != "":
				retry = c.Clone()
				retry.DropParams = append(append([]string{}, c.DropParams...), hint.DropParam)
			case hint.Rectify != "":
				retry = c.Clone()
				retry.Rectify = append(append([]string{}, c.Rectify...), hint.Rectify)
			default:
				retry = route.AlternateWire(cfg, c, ingress.Wire, []string{hint.ExcludeWire})
			}
		}
		if retry != nil {
			learnRetries++
			queue = append([]*cand.Candidate{retry}, queue...)
			continue
		}
		if last.text != nil && c.Wire == "responses" && !c.CustomToolsAsFunctions && learnRetries < MaxLearnRetries &&
			upstream.IsCustomToolRefusal(float64(last.status), *last.text, last.sent, true) {
			g.learner.CustomToolsRefused(c)
			learnRetries++
			x := c.Clone()
			x.CustomToolsAsFunctions = true
			queue = append([]*cand.Candidate{x}, queue...)
			continue
		}
		if last.status == 404 {
			var others []*cand.Candidate
			for _, o := range queue {
				if o.Provider.ID != c.Provider.ID {
					others = append(others, o)
				}
			}
			queue = others
			if len(others) > 0 {
				continue
			}
		}
		if !last.retryable && hint == nil {
			break
		}
	}
	if last == nil || last.kind == "failed" {
		raw := 502
		if last != nil {
			raw = last.status
		}
		status := gerr.ClientStatusOf(raw)
		var message string
		if len(errs) > 1 {
			message = "Nomi 网关：所有候选都失败了 —— " + strings.Join(errs, "；")
		} else if last != nil {
			message = last.message
		} else {
			message = "Nomi 网关：没有可用的候选"
		}
		if (raw == 401 || raw == 403) && len(errs) <= 1 {
			message = gerr.UpstreamAuthMessage(raw, message)
		}
		var ra *string
		if last != nil {
			ra = last.retryAfter
		}
		fail(status, message, ra)
		if trace != nil {
			_, _ = trace.Finish(u.NewObj("status", float64(status), "ms", NowMs()-startedAt, "attempts", float64(attempts), "error", message))
		}
		var lastDetail *u.Obj
		if len(attemptsDetail) > 0 {
			lastDetail, _ = attemptsDetail[len(attemptsDetail)-1].(*u.Obj)
		}
		cancelled := aborted()
		e := u.NewObj()
		if last != nil {
			e.Set("wire", last.cand.Wire)
			e.Set("provider", last.cand.Provider.ID)
			e.Set("keyId", last.cand.Key.ID)
			e.Set("model", last.cand.PublicModel)
			e.Set("upstreamModel", last.cand.UpstreamModel)
		}
		e.Set("status", float64(status))
		e.Set("usage", u.NewObj())
		e.Set("attempts", float64(attempts))
		e.Set("error", message)
		if len(resolveNotes) > 0 {
			e.Set("notes", strArr(resolveNotes))
		}
		if trace != nil {
			e.Set("traceId", trace.ID)
		}
		outcome := "gateway-error"
		if cancelled {
			outcome = "client-cancel"
		} else if lastDetail != nil {
			outcome, _ = lastDetail.Get("outcome").(string)
		}
		e.Set("outcome", outcome)
		if cancelled {
			e.Set("cancelPhase", "before-first")
		}
		if !cancelled && lastDetail != nil && lastDetail.Has("errorKind") {
			e.Set("errorKind", lastDetail.Get("errorKind"))
		}
		e.Set("timing", u.NewObj("endMs", 0.0))
		e.Set("attemptsDetail", attemptsDetail)
		for _, k := range quality.Keys() {
			e.Set(k, quality.Get(k))
		}
		report(e)
		return
	}
	up, c, stage := last.res, last.cand, last.stage
	winCand = c
	sentMasked := masked != nil && g.privacy.Applies(cfg, c)
	if !sentMasked {
		tag.Delete("redactions")
	}
	var restorer *privacy.Restorer
	if sentMasked && masked.Restore != nil && masked.Restore.Size() > 0 {
		restorer = privacy.NewRestorer(masked.Restore)
	}
	if restorer != nil && !res.sent() {
		res.setHeader(RedactedHeader, strconv.Itoa(masked.Restore.Size()))
	}
	notes := append(append([]string{}, resolveNotes...), last.notes...)
	mode := BridgeModeOf(c.Wire, ingress.Wire, c.CustomToolsAsFunctions)
	var out responded
	func() {
		defer func() {
			if held != nil {
				held()
			}
		}()
		defer func() {
			if p := recover(); p != nil {
				msg := ""
				if e, ok := p.(error); ok {
					msg = e.Error()
				} else if s, ok := p.(string); ok {
					msg = s
				}
				e := u.NewObj("wire", c.Wire, "provider", c.Provider.ID, "keyId", c.Key.ID, "model", c.PublicModel,
					"upstreamModel", c.UpstreamModel, "status", 500.0, "usage", u.NewObj(), "attempts", float64(attempts),
					"error", msg, "outcome", "gateway-error", "timing", u.NewObj("endMs", 0.0), "attemptsDetail", attemptsDetail, "mode", string(mode))
				for _, k := range quality.Keys() {
					e.Set(k, quality.Get(k))
				}
				report(e)
				panic(p)
			}
		}()
		out = g.respond(res, ingress, c, up, body, wantsStream, abortCtx, abort, &notes, trace, stage, resolveAs, restorer)
	}()
	if restorer != nil {
		if _, ok := tag.Get("redactions").([]any); ok {
			_, counts := restorer.Counts()
			tag.Set("redactions", hitsArr(masked.Hits, counts))
		}
	}
	usage := out.usage
	if trace != nil {
		f := u.NewObj("status", float64(up.Status), "ms", NowMs()-startedAt, "attempts", float64(attempts), "usage", usageObj(usage))
		if len(notes) > 0 {
			f.Set("notes", strArr(notes))
		}
		_, _ = trace.Finish(f)
	}
	RecordUsage(CalibrationKey{SessionKey: SessionKeyOf(ingress.Wire, req.Header, body), ProviderID: c.Provider.ID, Model: c.UpstreamModel, Wire: ingress.Wire},
		body, MeasuredInputTokens(c.Wire, &usage), nil)
	rel := func(at *float64) *float64 {
		if at == nil {
			return nil
		}
		return fp(*at - startedAt)
	}
	var firstContentMs *float64
	if out.streamed {
		if committedContentAt != nil {
			firstContentMs = rel(committedContentAt)
		} else {
			firstContentMs = rel(out.firstContentAt)
		}
	} else {
		firstContentMs = rel(out.firstContentAt)
	}
	atLeast := func(v *float64) *float64 {
		if v == nil || firstContentMs == nil {
			return v
		}
		return fp(math.Max(*v, *firstContentMs))
	}
	firstTextMs := atLeast(rel(out.firstTextAt))
	lastContentMs := atLeast(rel(out.lastContentAt))
	headersMs := rel(last.headersAt)
	qa := QualityAttempt{Provider: c.Provider.ID, KeyID: strp(c.Key.ID), Model: c.PublicModel, UpstreamWire: strp(c.Wire), Status: ip(up.Status), Outcome: out.outcome, Ms: NowMs() - wonAt}
	if last.headersAt != nil {
		qa.HeadersMs = fp(*last.headersAt - wonAt)
	}
	if out.errorKind != "" {
		qa.ErrorKind = strp(out.errorKind)
	}
	attemptsDetail = append(attemptsDetail, qaObj(qa))
	e := u.NewObj("wire", c.Wire, "provider", c.Provider.ID, "keyId", c.Key.ID, "model", c.PublicModel, "upstreamModel", c.UpstreamModel,
		"status", float64(up.Status), "usage", usageObj(usage))
	if firstContentMs != nil {
		e.Set("firstByteMs", *firstContentMs)
	}
	e.Set("attempts", float64(attempts))
	if len(notes) > 0 {
		e.Set("notes", strArr(notes))
	}
	if trace != nil {
		e.Set("traceId", trace.ID)
	}
	e.Set("outcome", out.outcome)
	if out.cancelPhase != "" {
		e.Set("cancelPhase", out.cancelPhase)
	}
	if out.errorKind != "" {
		e.Set("errorKind", out.errorKind)
	}
	timing := u.NewObj()
	if headersMs != nil {
		timing.Set("headersMs", *headersMs)
	}
	if firstContentMs != nil {
		timing.Set("firstContentMs", *firstContentMs)
	}
	if firstTextMs != nil {
		timing.Set("firstTextMs", *firstTextMs)
	}
	if lastContentMs != nil {
		timing.Set("lastContentMs", *lastContentMs)
	}
	timing.Set("endMs", 0.0)
	e.Set("timing", timing)
	e.Set("attemptsDetail", attemptsDetail)
	if out.streamed && IsBurst(firstContentMs, lastContentMs, usage.OutputTokens) {
		e.Set("burst", true)
	}
	e.Set("mode", string(mode))
	for _, k := range quality.Keys() {
		e.Set(k, quality.Get(k))
	}
	report(e)
}

func strArr(s []string) []any {
	a := make([]any, len(s))
	for i, x := range s {
		a[i] = x
	}
	return a
}

// hitsArr is the redaction hits; counts != nil sets restored (restorer.counts).
func hitsArr(hits []*privacy.RedactionHit, counts map[string]int) []any {
	a := make([]any, len(hits))
	for i, h := range hits {
		o := h.Obj()
		if counts != nil {
			o.Set("restored", float64(counts[h.Placeholder]))
		}
		a[i] = o
	}
	return a
}

// withSuppression: suppressed (provider, key, wire) try another wire first (§7.4).
func (g *GatewayServer) withSuppression(cfg *config.GatewayConfig, cands []*cand.Candidate, ingress string) []*cand.Candidate {
	var head, tail []*cand.Candidate
	for _, c := range cands {
		if !g.learner.IsSuppressed(c) {
			head = append(head, c)
			continue
		}
		if alt := route.AlternateWire(cfg, c, ingress, []string{c.Wire}); alt != nil && !g.learner.IsSuppressed(alt) {
			head = append(head, alt)
		}
		tail = append(tail, c)
	}
	return append(head, tail...)
}

// ordered: sticky first, demoted then cooling last (§11.1, §11.2).
func (g *GatewayServer) ordered(cands []*cand.Candidate, sticky *AffinityTarget) []*cand.Candidate {
	var first, rest, demoted, cooling []*cand.Candidate
	adaptive := AdaptiveRouteEnabled()
	for _, c := range cands {
		switch {
		case g.cool.IsCooling(c):
			cooling = append(cooling, c)
		case adaptive && g.Metrics.ShouldDemote(c.Provider.ID, c.Key.ID, c.Wire):
			demoted = append(demoted, c)
		case sticky != nil && c.Provider.ID == sticky.ProviderID && c.Key.ID == sticky.KeyID:
			first = append(first, c)
		default:
			rest = append(rest, c)
		}
	}
	out := append(append(append(first, rest...), demoted...), cooling...)
	return out
}

func stagedResp(r *Resp, stage *providers.Stage, onRaw func(string)) *Resp {
	if r.Body == nil {
		return r
	}
	hr := &http.Response{Status: strconv.Itoa(r.Status) + " " + r.StatusText, StatusCode: r.Status, Header: r.Header, Body: &chunksReadCloser{c: r.Body}}
	x := *r
	x.Body = ChunksOf(providers.StagedResponse(hr, stage, onRaw).Body)
	return &x
}

// chunksReadCloser adapts Chunks back to an io.ReadCloser; one Read returns
// at most one chunk, so chunk boundaries survive a large enough buffer.
type chunksReadCloser struct {
	c    Chunks
	rest []byte
}

func (r *chunksReadCloser) Read(p []byte) (int, error) {
	if len(r.rest) > 0 {
		n := copy(p, r.rest)
		r.rest = r.rest[n:]
		return n, nil
	}
	b, err := r.c.Next()
	n := copy(p, b)
	if n < len(b) {
		r.rest = b[n:]
	}
	if n > 0 && err == io.EOF {
		return n, nil
	}
	return n, err
}
func (r *chunksReadCloser) Close() error { return r.c.Close() }

func isSseResponse(r *Resp) bool {
	return r.Body != nil && strings.Contains(strings.Join(r.Header.Values("content-type"), ", "), "text/event-stream")
}

// sseFailure is sseFailure(wire, message).
func sseFailure(wire, message string) string {
	ev := stream.PassthroughFail(wire, message)
	if wire != "responses" {
		return ev
	}
	c := canonical.NewResponsesCanonicalizer("")
	return c.Push(ev) + c.End()
}

// attempt is one upstream try; a 2xx header counts as success.
func (g *GatewayServer) attempt(cfg *config.GatewayConfig, client string, req *http.Request, ingress *upstream.Ingress, c *cand.Candidate,
	body any, wantsStream bool, signal context.Context, trace *RequestTrace, bindingEffort *string) *attemptT {
	base, _ := c.Provider.URLs.Get(c.Wire).(string)
	target := upstream.URL(c.Wire, base, c.UpstreamModel, upstream.URLOpts{Stream: wantsStream})
	var notes []string
	sent, err := upstream.Body(ingress.Wire, c, body, upstream.BodyOpts{Stream: wantsStream, IngressModel: ingress.Model, Notes: &notes, Client: client, BindingEffort: bindingEffort})
	if err != nil {
		var up *request.UnsupportedParamError
		if errors.As(err, &up) {
			return &attemptT{kind: "failed", status: 400, message: up.Error(), cand: c, outcome: "request-rejected", errorKind: "strict-param"}
		}
		panic(err)
	}
	if tooMany := upstream.ToolLimitError(c, sent); tooMany != "" {
		return &attemptT{kind: "failed", status: 400, message: tooMany, retryable: true, cand: c, outcome: "request-rejected", errorKind: "too-many-tools"}
	}
	if noSearch := providers.ServerToolError(c, ingress.Wire, body); noSearch != "" {
		return &attemptT{kind: "failed", status: 400, message: noSearch, retryable: true, cand: c, outcome: "request-rejected", errorKind: "server-tool"}
	}
	if len(notes) > 0 && g.hooks.Logger != nil {
		g.hooks.Logger.Info("gateway request fixes", u.NewObj("model", c.PublicModel, "notes", strArr(notes)))
	}
	firstByteMs := upstream.ResolveFirstByteTimeoutMs(wantsStream, upstream.CandidateIsReasoning(c), g.hooks.TimeoutHooks)
	both, cancelBoth := context.WithCancel(signal)
	var firstByteFired atomic.Bool
	timer := time.AfterFunc(time.Duration(firstByteMs*float64(time.Millisecond)), func() { firstByteFired.Store(true); cancelBoth() })
	headers := upstream.Headers(c, upstream.HeaderOpts{Stream: wantsStream, ClientHeaders: nodeHeaders(req.Header), SameWire: ingress.Wire == c.Wire})
	if trace != nil {
		kn := keyName(c)
		trace.Attempt(u.NewObj("provider", c.Provider.Name, "key", kn, "wire", c.Wire, "url", target, "headers", headers, "body", sent))
	}
	hreq, rerr := http.NewRequestWithContext(both, "POST", target, strings.NewReader(u.Stringify(sent)))
	var hres *http.Response
	if rerr == nil {
		for _, k := range headers.Keys() {
			if s, ok := headers.Get(k).(string); ok {
				hreq.Header[k] = []string{s}
			}
		}
		hres, rerr = g.doFetch(hreq)
	}
	timer.Stop()
	if rerr != nil {
		var blocked *gwnet.UpstreamBlockedError
		if errors.As(rerr, &blocked) {
			return &attemptT{kind: "failed", status: 400, message: blocked.Error(), retryable: true, cand: c, outcome: "gateway-error", errorKind: "blocked-upstream"}
		}
		sigAborted := signal.Err() != nil
		timedOut := firstByteFired.Load() && !sigAborted
		f := &attemptT{kind: "failed", retryable: !sigAborted, cand: c, network: !sigAborted}
		if timedOut {
			f.status, f.message = 504, "上游在首字节前超时"
		} else {
			f.status, f.message = 502, "连接上游失败："+fetchErrMessage(both)
		}
		switch {
		case sigAborted:
			f.outcome = "client-cancel"
		case timedOut:
			f.outcome = "first-byte-timeout"
		default:
			f.outcome, f.errorKind = "upstream-5xx", "connect"
		}
		return f
	}
	res := RespOf(hres)
	if hres.StatusCode >= 200 && hres.StatusCode <= 299 {
		a := &attemptT{kind: "response", res: res, cand: c, headersAt: fp(NowMs())}
		if len(notes) > 0 {
			a.notes = notes
		}
		return a
	}
	text, terr := jsDecodeAll(res.Body)
	if res.Body != nil {
		_ = res.Body.Close()
	}
	if terr != nil {
		text = ""
	}
	s := hres.StatusCode
	if trace != nil {
		trace.AttemptResult(s, text)
	}
	retryable := s == 429 || s >= 500 || s == 401 || s == 403 || (s >= 300 && s < 400)
	f := &attemptT{kind: "failed", retryable: retryable, cand: c, text: &text, sent: sent, upstreamStatus: ip(s), retryAfter: headerGet(hres.Header, "retry-after")}
	if s >= 300 && s < 400 {
		f.status, f.message = 502, "上游返回重定向（"+strconv.Itoa(s)+"），网关不跟随"
	} else {
		f.status, f.message = s, gerr.UpstreamMessage(text)
	}
	return f
}

// respond writes the 2xx upstream response back in the ingress protocol.
func (g *GatewayServer) respond(res *gwRes, ingress *upstream.Ingress, c *cand.Candidate, up *Resp, body any, wantsStream bool,
	abortCtx context.Context, abort context.CancelFunc, notes *[]string, trace *RequestTrace, stage *providers.Stage, client string, restorer *privacy.Restorer) responded {
	if !res.sent() {
		res.setHeader(ServedModelHeader, c.PublicModel)
	}
	mode := BridgeModeOf(c.Wire, ingress.Wire, c.CustomToolsAsFunctions)
	passthrough := mode == "passthrough"
	ct := headerGet(up.Header, "content-type")
	isSse := ct != nil && strings.Contains(*ct, "text/event-stream")
	fixes := upstream.ResponseFixOptions(ingress.Wire, c, body, notes)
	var customTools map[string]bool
	if ingress.Wire == "responses" {
		customTools = map[string]bool{}
		for _, n := range upstream.CustomToolNames(body) {
			customTools[n] = true
		}
	}
	if wantsStream && isSse && up.Body != nil {
		res.mu.Lock()
		if !res.headersSent {
			res.writeHeadLocked(200, sseHeaders)
		}
		res.mu.Unlock()
		spec := clients.ClientSpecOf(client)
		tap := NewUsageTap(c.Wire)
		plan := BridgePlan{From: c.Wire, To: ingress.Wire, Mode: mode, Model: c.PublicModel, CustomTools: customTools, Fixes: fixes}
		if spec != nil && spec.Heartbeat != "" {
			plan.Heartbeat = spec.Heartbeat
		}
		bridge := CreateBridge(plan)
		var conformer *clients.Conformer
		if spec != nil && clients.ConformNeeded(spec, clients.ClientHooksOf(client)) {
			conformer = clients.NewConformer(&clients.ConformContext{Spec: spec, Wire: ingress.Wire, Notes: notes})
		}
		conform := func(t string) string {
			if conformer != nil && t != "" {
				return conformer.Push(t)
			}
			return t
		}
		conformerEnd := func() string {
			if conformer != nil {
				return conformer.End()
			}
			return ""
		}
		var dec u.TextDecoder
		reader := up.Body
		idleMs := upstream.ResolveStreamIdleTimeoutMs(g.hooks.TimeoutHooks)
		var idle *time.Timer
		var idleFired atomic.Bool
		outcome := "ok"
		errorKind := ""
		timing := func(r responded) responded {
			r.firstContentAt, r.firstTextAt, r.lastContentAt = tap.FirstContentAt, tap.FirstTextAt, tap.LastContentAt
			return r
		}
		arm := func() {
			if idle != nil {
				idle.Stop()
			}
			idle = time.AfterFunc(time.Duration(idleMs*float64(time.Millisecond)), func() { idleFired.Store(true); abort() })
		}
		defer func() {
			if idle != nil {
				idle.Stop()
			}
			_ = reader.Close()
		}()
		var readErr error
		arm()
		for {
			chunk, err := reader.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				readErr = err
				break
			}
			arm()
			if res.destroyed() {
				return timing(responded{usage: tap.Usage, outcome: "client-cancel", cancelPhase: "during", streamed: true})
			}
			text := dec.Decode(chunk)
			tap.Push(text)
			if stage == nil && trace != nil {
				trace.Response(up.Status, text)
			}
			out := bridge.Push(text)
			if stage != nil && stage.Alive != 0 {
				stage.Alive = 0
				out += bridge.Alive()
			}
			out = conform(out)
			if restorer != nil {
				out = restorer.Push(out)
			}
			if out != "" {
				if idle != nil {
					idle.Stop()
				}
				res.write(out)
				arm()
			}
			if bridge.Stopped() {
				break
			}
		}
		if readErr == nil {
			rest := ""
			if !bridge.Stopped() {
				rest = dec.Flush()
			}
			tap.Push(rest)
			tap.FlushResidual()
			if bridge.Stopped() {
				outcome = "repetition-stop"
			} else if tap.Error != nil {
				et := ""
				if tap.ErrorType != nil {
					et = *tap.ErrorType
				}
				cl := ClassifyStreamError(*tap.Error, et)
				outcome = cl.Outcome
				if cl.ErrorKind != nil {
					errorKind = *cl.ErrorKind
				}
			} else if !tap.Terminated() {
				outcome, errorKind = "stream-break", "no-terminal"
			}
			tail := conform(bridge.End(rest)) + conformerEnd()
			if restorer != nil {
				tail = restorer.Push(tail) + restorer.End()
			}
			if tail != "" {
				res.write(tail)
			}
			if bridge.Stopped() && idle != nil {
				idle.Stop()
			}
		} else {
			if idleFired.Load() {
				outcome = "idle-timeout"
			} else if res.destroyed() {
				outcome = "client-cancel"
			} else {
				outcome, errorKind = "stream-break", "network"
			}
			if !res.destroyed() {
				var msg string
				if idleFired.Load() {
					msg = "Nomi 网关：上游 " + strconv.Itoa(int(math.Floor(idleMs/1000+0.5))) + " 秒没有任何输出，已中断"
				} else {
					msg = "Nomi 网关：上游中断（" + bodyErrMessage(abortCtx) + "）"
				}
				pre := ""
				if restorer != nil {
					pre = restorer.End()
				}
				res.write(pre + conform(bridge.Fail(msg)) + conformerEnd())
			}
		}
		if idle != nil {
			idle.Stop()
		}
		if !res.destroyed() {
			res.end("")
		}
		usage := tap.End()
		r := responded{usage: usage, outcome: outcome, errorKind: errorKind, streamed: true}
		if outcome == "client-cancel" {
			r.cancelPhase = "during"
		}
		return timing(r)
	}
	bodyMs := upstream.ResolveFirstByteTimeoutMs(false, upstream.CandidateIsReasoning(c), g.hooks.TimeoutHooks)
	var bodyTimedOut atomic.Bool
	bodyTimer := time.AfterFunc(time.Duration(bodyMs*float64(time.Millisecond)), func() { bodyTimedOut.Store(true); abort() })
	text, terr := jsDecodeAll(up.Body)
	bodyTimer.Stop()
	if up.Body != nil {
		_ = up.Body.Close()
	}
	if terr != nil {
		var msg string
		if bodyTimedOut.Load() {
			msg = "Nomi 网关：上游响应正文 " + strconv.Itoa(int(math.Max(1, math.Floor(bodyMs/1000+0.5)))) + " 秒内没有读完，已中断"
		} else {
			msg = "Nomi 网关：上游中断（" + bodyErrMessage(abortCtx) + "）"
		}
		st, eb := gerr.ErrorResponse(ingress.Wire, gerr.KindOfStatus(502, msg), msg)
		if !res.sent() {
			sendJSON(res, st, eb)
		} else {
			res.end("")
		}
		cancelled := !bodyTimedOut.Load() && res.destroyed()
		r := responded{usage: events.StreamUsage{}, streamed: false}
		switch {
		case bodyTimedOut.Load():
			r.outcome = "idle-timeout"
		case cancelled:
			r.outcome = "client-cancel"
		default:
			r.outcome = "stream-break"
		}
		if cancelled {
			r.cancelPhase = "during"
		}
		if !bodyTimedOut.Load() && !cancelled {
			r.errorKind = "network"
		}
		return r
	}
	bodyAt := NowMs()
	if trace != nil {
		trace.Response(up.Status, text)
	}
	var parsed any = text
	if v, err := u.ParseString(text); err == nil {
		parsed = v
	}
	usage := events.StreamUsage{}
	if _, isStr := parsed.(string); !isStr {
		switch parsed.(type) {
		case float64, bool:
		default:
			usage = UsageOfJSON(c.Wire, parsed)
		}
	}
	pm := BridgeMode("convert")
	if passthrough {
		pm = "passthrough"
	}
	out := BridgeJSON(BridgePlan{From: c.Wire, To: ingress.Wire, Mode: pm, Model: c.PublicModel, CustomTools: customTools, Fixes: fixes},
		UpstreamJSON{Status: up.Status, ContentType: ct, Text: text, Parsed: parsed}, wantsStream)
	switch out.Kind {
	case "sse":
		res.writeHead(200, "Content-Type", "text/event-stream; charset=utf-8", "Cache-Control", "no-cache")
		if restorer != nil {
			res.end(restorer.Push(out.Body) + restorer.End())
		} else {
			res.end(out.Body)
		}
	case "raw":
		res.writeHead(out.Status, "Content-Type", out.ContentType)
		if restorer != nil {
			res.end(restorer.Raw(out.Body))
		} else {
			res.end(out.Body)
		}
	default:
		if restorer != nil {
			sendJSON(res, out.Status, restorer.JSON(out.JSON))
		} else {
			sendJSON(res, out.Status, out.JSON)
		}
	}
	return responded{usage: usage, outcome: "ok", streamed: false, firstContentAt: fp(bodyAt), lastContentAt: fp(bodyAt), firstTextAt: fp(bodyAt)}
}

// countTokens: forward when both sides are Messages, else estimate (§10.1, §10.3).
func (g *GatewayServer) countTokens(res *gwRes, cfg *config.GatewayConfig, ingress *upstream.Ingress, body any, c *cand.Candidate) {
	if ingress.Wire == "messages" && c.Wire == "messages" {
		if done := func() bool {
			target := upstream.URL("messages", urlOf(c, "messages"), c.UpstreamModel, upstream.URLOpts{CountTokens: true})
			o := spreadObj(body)
			o.Set("model", c.UpstreamModel)
			fixed, err := upstream.ApplyRequestFixes(c, o, nil)
			if err != nil {
				return false
			}
			ms := upstream.ResolveFirstByteTimeoutMs(true, false, g.hooks.TimeoutHooks)
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(ms*float64(time.Millisecond)))
			defer cancel()
			hreq, err := http.NewRequestWithContext(ctx, "POST", target, strings.NewReader(u.Stringify(fixed)))
			if err != nil {
				return false
			}
			h := upstream.Headers(c, upstream.HeaderOpts{Stream: false, ClientHeaders: map[string]any{}, SameWire: true})
			for _, k := range h.Keys() {
				if s, ok := h.Get(k).(string); ok {
					hreq.Header[k] = []string{s}
				}
			}
			up, err := g.doFetch(hreq)
			if err != nil {
				return false
			}
			defer up.Body.Close()
			if up.StatusCode < 200 || up.StatusCode > 299 {
				return false
			}
			text, err := jsDecodeAll(ChunksOf(up.Body))
			if err != nil {
				return false
			}
			v, err := u.ParseString(text)
			if err != nil {
				return false
			}
			sendJSON(res, 200, v)
			return true
		}(); done {
			return
		}
	}
	n := CalibratedCount(CalibrationKey{SessionKey: SessionKeyOf(ingress.Wire, res.req.Header, body), ProviderID: c.Provider.ID, Model: c.UpstreamModel, Wire: ingress.Wire}, body, nil)
	if ingress.Wire == "gemini" {
		sendJSON(res, 200, u.NewObj("totalTokens", n))
	} else {
		sendJSON(res, 200, u.NewObj("input_tokens", n))
	}
}

// spreadObj is `{ ...(body as object) }`.
func spreadObj(v any) *u.Obj {
	switch x := v.(type) {
	case *u.Obj:
		return x.Clone()
	case []any:
		o := u.NewObj()
		for i, e := range x {
			o.Set(strconv.Itoa(i), e)
		}
		return o
	case string:
		o := u.NewObj()
		i := 0
		for _, r := range x {
			for _, unit := range u.ToUnits(string(r)) {
				o.Set(strconv.Itoa(i), u.FromUnits(u.Units{unit}))
				i++
			}
		}
		_ = utf8.RuneLen
		return o
	}
	return u.NewObj()
}

func keyName(c *cand.Candidate) string {
	if c.Key.Name != "" {
		return c.Key.Name
	}
	return c.Key.ID
}

func urlOf(c *cand.Candidate, w string) string { s, _ := c.Provider.URLs.Get(w).(string); return s }
