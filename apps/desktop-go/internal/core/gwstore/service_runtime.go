package gwstore

// service_runtime.go = GatewayService 的运行时部分：runtimeConfig / config / envRuntime / push / commit /
// changed / onChange / status / whenReady / endpoint / address / liveUrl / configuredUrl / readyFetch /
// nomiRoute / nomiPick / nomiProvider / providerInfo / credentials / listOpenAiCompatible。

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/config"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/models"
	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// EnvProvider = GatewayServiceDeps.envProviders() 的条目
type EnvProvider struct {
	ID, Name, Wire, URL, Key, KeyEnv, Model string
}

// RuntimeDeps = GatewayServiceDeps 中运行时相关的部分
type RuntimeDeps struct {
	Root           string
	Port           *int
	Lazy           bool
	Env            map[string]string
	EnvProviders   func() []EnvProvider
	LegacyToken    func() string
	RouteListening func() bool
	TraceDir       func() string
	Broadcast      func(event string, payload any)
	OnUsage        func(e *u.Obj)
	Process        *GatewayProcess
	Fork           ForkGateway
	// LongContextPrice = usage.longContextPrice（nil = 不给价格）
	LongContextPrice func(model string) *u.Obj
	// Detect = detectImpl ?? detect（nil = detect 未移植，wire-suspect 不学）
	Detect DetectFunc
}

type runtimeState struct {
	d            RuntimeDeps
	proc         *GatewayProcess
	lmu          sync.Mutex
	listeners    map[int]func()
	nextL        int
	learnGen     map[string]int
	httpc        *http.Client
	privacyLog   *PrivacyLog
	tabs         *TabTokens
	legacyRevoke *u.Obj
	mu           sync.Mutex // 存储写入串行（Node 单线程）
}

// AttachRuntime：GatewayService 构造里的 GatewayProcess 接线（init 之前调用）
func (s *Service) AttachRuntime(d RuntimeDeps) {
	rt := &runtimeState{d: d, listeners: map[int]func(){}, learnGen: map[string]int{}}
	s.rt = rt
	if d.Process != nil {
		rt.proc = d.Process
	} else {
		fork := d.Fork
		if fork == nil {
			fork = InProcessFork(server.GatewayHooks{Logger: s.logger})
		}
		rt.proc = NewGatewayProcess(ProcessDeps{
			Logger: s.logger,
			Lazy:   d.Lazy,
			Fork:   fork,
			OnUsage: func(e *u.Obj) {
				s.NotePrivacy(e)
				if d.OnUsage != nil {
					d.OnUsage(e)
				}
			},
			OnLearn:     func(e server.LearnEvent) { go s.Learn(e) },
			OnKeyStatus: func(e upstream.KeyStatusEvent) { s.KeyStatus(e) },
			OnStatus:    func(GatewayStatus) { s.changed() },
		})
	}
	rt.privacyLog = NewPrivacyLog(filepath.Join(d.Root, "privacy-log.json"), nil)
	rt.tabs = NewTabTokens(TabTokensDeps{Send: rt.proc.Send, Logger: s.logger, Random: func(n int) []byte { return RandomBytes(n) }})
	rt.proc.BindTabs(rt.tabs.OnAck, rt.tabs.Replay)
	rt.httpc = &http.Client{Transport: readyTransport{s}}
}

// Start = init() 的后半段：读同步目录 → push → 端口固定时按需，系统分配时直接起
func (s *Service) Start() {
	if s.rt == nil {
		return
	}
	models.SetCatalogOverlay(models.ReadCatalogFile(s.catalogFile()))
	s.push()
	if s.configuredURL() == "" {
		s.rt.proc.EnsureStarted()
	}
}

func (s *Service) catalogFile() string { return filepath.Join(s.rt.d.Root, "catalog-sync.json") }

// HasCatalogSync = hasCatalogSync()
func (s *Service) HasCatalogSync() bool { return models.CatalogOverlayVersion() != nil }

// EnsureStarted = ensureStarted()
func (s *Service) EnsureStarted() { s.rt.proc.EnsureStarted() }

// Dispose = dispose() 中停网关进程的部分
func (s *Service) Dispose() {
	if s.rt != nil {
		s.rt.privacyLog.Flush()
		s.rt.proc.Stop()
	}
}

func (s *Service) routeListening() bool {
	return s.legacy != nil && s.rt.d.RouteListening != nil && s.rt.d.RouteListening()
}

func (s *Service) configuredURL() string {
	port := 0
	if !s.routeListening() {
		if s.rt.d.Port != nil {
			port = *s.rt.d.Port
		} else {
			port = int(s.Store.Port())
		}
	}
	if port == 0 {
		return ""
	}
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

func (s *Service) liveURL(start bool) string {
	st := s.rt.proc.GetStatus()
	if st.State == "running" {
		return st.URL
	}
	if st.State == "failed" {
		return ""
	}
	url := s.configuredURL()
	if url != "" && start {
		s.rt.proc.EnsureStarted()
	}
	return url
}

// Endpoint = { url, token }
type Endpoint struct{ URL, Token string }

func (s *Service) address(client string, start bool) *Endpoint {
	token, ok := s.Store.ClientToken(client)
	if !ok || token == "" {
		return nil
	}
	url := s.liveURL(start)
	if url == "" {
		return nil
	}
	return &Endpoint{URL: url, Token: token}
}

// Endpoint = endpoint(client)
func (s *Service) Endpoint(client string) *Endpoint { return s.address(client, true) }

// readyTransport = readyFetch：网关还没就绪就先等它起来，起不来按「AI 服务未就绪」失败
type readyTransport struct{ s *Service }

func (t readyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	p := t.s.rt.proc
	if p.GetStatus().State != "running" && !p.WhenReady(0) {
		return nil, errors.New(i18n.T("electron.common.ai-service-not-ready"))
	}
	return http.DefaultTransport.RoundTrip(r)
}

// ReadyClient：readyFetch 对应的 http.Client
func (s *Service) ReadyClient() *http.Client { return s.rt.httpc }

// RuntimeConfig = runtimeConfig()
func (s *Service) RuntimeConfig() *u.Obj {
	cfg := s.config()
	cfg.Set("sessionsFile", filepath.Join(s.rt.d.Root, "sessions.json"))
	if s.HasCatalogSync() {
		cfg.Set("catalogFile", s.catalogFile())
	}
	if s.rt.d.TraceDir != nil {
		if td := s.rt.d.TraceDir(); td != "" {
			cfg.Set("traceDir", td)
		}
	}
	if s.rt.d.Env["NOMI_ROUTE_PLAN"] == "shadow" {
		cfg.Set("routePlan", "shadow")
	} else {
		cfg.Set("routePlan", "active")
	}
	if s.rt.d.Port != nil {
		cfg.Set("port", float64(*s.rt.d.Port))
	}
	if s.routeListening() {
		cfg.Set("port", 0.0)
	}
	return cfg
}

func hostPortOf(raw string) string {
	pu, err := gwnet.ParseURL(raw)
	if err != nil {
		return ""
	}
	port := pu.Port()
	if port == "" {
		if pu.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	h := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(pu.Hostname(), "["), "]"))
	return h + ":" + port
}

func privateURL(raw string) bool {
	pu, err := gwnet.ParseURL(raw)
	if err != nil {
		return false
	}
	h := pu.Hostname()
	if strings.Contains(h, ":") {
		h = "[" + h + "]" // WHATWG hostname 带方括号
	}
	return gwnet.IsPrivateHost(h)
}

func (s *Service) config() *u.Obj {
	env := s.envRuntime()
	legacy := ""
	if s.legacy != nil && s.rt.d.LegacyToken != nil {
		legacy = s.rt.d.LegacyToken()
	}
	cfg := s.Store.RuntimeConfig(RuntimeExtra{LegacyToken: legacy, EnvProviders: env})
	hosts := []any{}
	seen := map[string]bool{}
	add := func(h string) {
		if !seen[h] {
			seen[h] = true
			hosts = append(hosts, h)
		}
	}
	if a, ok := cfg.Get("allowedPrivateHosts").([]any); ok {
		for _, h := range a {
			if hs, ok := h.(string); ok {
				add(hs)
			}
		}
	}
	for _, p := range env {
		urls := asObj(p.(*u.Obj).Get("urls"))
		for _, w := range urls.Keys() {
			if url, ok := urls.Get(w).(string); ok && url != "" && privateURL(url) {
				if hp := hostPortOf(url); hp != "" {
					add(hp)
				}
			}
		}
	}
	cfg.Set("allowedPrivateHosts", hosts)
	return cfg
}

func (s *Service) envList() []EnvProvider {
	if s.rt.d.EnvProviders == nil {
		return nil
	}
	return s.rt.d.EnvProviders()
}

func (s *Service) envRuntime() []any {
	out := []any{}
	for _, e := range s.envList() {
		models := []any{}
		if e.Model != "" {
			models = append(models, u.NewObj("id", e.Model, "enabled", true))
		}
		out = append(out, u.NewObj(
			"id", "env-"+e.ID, "name", e.Name, "enabled", true,
			"urls", u.NewObj(e.Wire, e.URL),
			"keys", []any{u.NewObj("id", "env", "value", e.Key, "enabled", true)},
			"models", models,
		))
	}
	return out
}

func (s *Service) push() { s.rt.proc.Apply(s.RuntimeConfig()) }

// Refresh = refresh()
func (s *Service) Refresh() { s.push() }

func (s *Service) commit() error {
	err := s.Store.Save()
	s.push()
	s.changed()
	return err
}

// OnChange = onChange(fn)：返回取消订阅
func (s *Service) OnChange(fn func()) func() {
	s.rt.lmu.Lock()
	id := s.rt.nextL
	s.rt.nextL++
	s.rt.listeners[id] = fn
	s.rt.lmu.Unlock()
	return func() {
		s.rt.lmu.Lock()
		delete(s.rt.listeners, id)
		s.rt.lmu.Unlock()
	}
}

func (s *Service) changed() {
	if s.rt.d.Broadcast != nil {
		s.rt.d.Broadcast("gateway.changed", nil)
	}
	s.rt.lmu.Lock()
	ids := make([]int, 0, len(s.rt.listeners))
	for id := range s.rt.listeners {
		ids = append(ids, id)
	}
	fns := make([]func(), 0, len(ids))
	for i := 0; i < s.rt.nextL; i++ { // 插入顺序（同 Set 迭代）
		if f, ok := s.rt.listeners[i]; ok {
			fns = append(fns, f)
		}
	}
	s.rt.lmu.Unlock()
	for _, fn := range fns {
		func() {
			defer func() {
				if r := recover(); r != nil && s.logger != nil {
					s.logger.Warn("gateway change listener failed", r)
				}
			}()
			fn()
		}()
	}
}

// Status = status()
func (s *Service) Status() GatewayStatus { return s.rt.proc.GetStatus() }

// WhenReady = whenReady(timeoutMs)
func (s *Service) WhenReady(timeout time.Duration) bool { return s.rt.proc.WhenReady(timeout) }

// NomiRoute = nomiRoute(role) 的结果
type NomiRoute struct {
	BaseURL, Token, Model, Protocol string
	ReceiverID, ReceiverBaseURL     string
	Client                          *http.Client
}

type nomiPicked struct {
	*route.Preferred
	receiver route.Upstream
}

func (s *Service) gatewayConfig() *config.GatewayConfig {
	c, err := ToGatewayConfig(s.config())
	if err != nil {
		return &config.GatewayConfig{}
	}
	return c
}

func (s *Service) nomiPick(role string) *nomiPicked {
	ms := asObj(objGet(s.Store.Snapshot(), "clients", "nomi", "models"))
	cfg := s.gatewayConfig()
	main, _ := ms.Get("main").(string)
	if main == "" {
		for _, p := range cfg.Providers {
			if strings.HasPrefix(p.ID, "env-") && len(p.Models) > 0 {
				main = p.ID + "/" + p.Models[0].ID
				break
			}
		}
	}
	if main == "" {
		return nil
	}
	ref := ""
	switch role {
	case "agent-tools":
		ref, _ = ms.Get("tools").(string)
	case "summary":
		ref, _ = ms.Get("summary").(string)
	}
	if ref == "" {
		ref = main
	}
	picked := route.PreferredWire(cfg, "nomi", ref)
	if picked == nil || len(picked.Upstreams) == 0 {
		return nil
	}
	recv := picked.Upstreams[0]
	for _, up := range picked.Upstreams {
		if !privateURL(up.URL) {
			recv = up
			break
		}
	}
	return &nomiPicked{picked, recv}
}

// NomiRoute = nomiRoute(role)：网关没在运行或没配模型时 nil
func (s *Service) NomiRoute(role string) *NomiRoute {
	ep := s.address("nomi", false)
	picked := s.nomiPick(role)
	if ep == nil || picked == nil {
		return nil
	}
	r := &NomiRoute{Token: ep.Token, Model: picked.PublicModel, ReceiverID: picked.receiver.ProviderID,
		ReceiverBaseURL: picked.receiver.URL, Client: s.rt.httpc}
	switch picked.Wire {
	case "messages":
		r.BaseURL, r.Protocol = ep.URL, "anthropic"
	case "responses":
		r.BaseURL, r.Protocol = ep.URL+"/v1", "openai-responses"
	default:
		r.BaseURL, r.Protocol = ep.URL+"/v1", "openai-chat"
	}
	return r
}

// NomiProvider = nomiProvider(role)
func (s *Service) NomiProvider(role string) *u.Obj {
	p := s.nomiPick(role)
	if p == nil {
		return nil
	}
	head := p.Upstreams[0]
	return u.NewObj("id", head.ProviderID, "name", head.Name, "baseURL", p.receiver.URL,
		"model", sliceFrom(p.PublicModel, len(head.ProviderID)+1))
}

// ProviderInfo = providerInfo(id)
func (s *Service) ProviderInfo(id string) *u.Obj {
	for _, raw := range s.Store.Providers() {
		p := asObj(raw)
		match := p.Get("id") == id
		if al, ok := p.Get("aliases").([]any); ok && !match {
			for _, a := range al {
				if a == id {
					match = true
				}
			}
		}
		if !match {
			continue
		}
		urls := []string{}
		uo := asObj(p.Get("urls"))
		for _, w := range uo.Keys() {
			if v, ok := uo.Get(w).(string); ok && v != "" {
				urls = append(urls, v)
			}
		}
		base := ""
		for _, v := range urls {
			if !privateURL(v) {
				base = v
				break
			}
		}
		if base == "" && len(urls) > 0 {
			base = urls[0]
		}
		return u.NewObj("id", p.Get("id"), "name", p.Get("name"), "baseURL", base)
	}
	return nil
}

// Credentials = credentials(id)：只在主进程内使用
func (s *Service) Credentials(id string) *u.Obj {
	for _, raw := range s.Store.Providers() {
		p := asObj(raw)
		if p.Get("id") != id || !u.Truthy(p.Get("enabled")) {
			continue
		}
		chat, _ := objGet(p, "urls", "chat").(string)
		if chat == "" {
			return nil
		}
		o := u.NewObj("id", p.Get("id"), "name", p.Get("name"), "baseURL", chat)
		ks, _ := p.Get("keys").([]any)
		for _, kr := range ks {
			k := asObj(kr)
			w := k.Get("wire")
			if !u.Truthy(k.Get("enabled")) || (u.Truthy(w) && w != "chat") {
				continue
			}
			if v, ok := s.Store.Decrypt(k.Get("enc"), k.Get("encryption")); ok && v != "" {
				o.Set("apiKey", v)
				break
			}
		}
		return o
	}
	return nil
}

// ListOpenAiCompatible = listOpenAiCompatible()
func (s *Service) ListOpenAiCompatible() []any {
	out := []any{}
	for _, raw := range s.Store.Providers() {
		p := asObj(raw)
		chat, _ := objGet(p, "urls", "chat").(string)
		if u.Truthy(p.Get("enabled")) && chat != "" {
			out = append(out, u.NewObj("id", p.Get("id"), "name", p.Get("name"), "baseURL", chat))
		}
	}
	return out
}

func sliceFrom(s string, n int) string {
	if n >= len(s) {
		return ""
	}
	return s[n:]
}
