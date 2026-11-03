package providerlink

// 流程 = ProviderLinkService.ts：宿主把收到的 `nomi://provider/*` 交给 Receive，这里解析、（B 档）读授权清单 / 换 Key，
// 产出「待确认」交给视图；用户确认后才写进网关。链接里有 Key：日志只记类型；视图只拿到打码后的 Key。

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	gwnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	OfferTTL       = 10 * time.Minute
	MaxOffers      = 5
	fetchTimeout   = 15 * time.Second
	maxBody        = 64 * 1024
	stageAuthorize = "authorize"
	stageSave      = "save"
	stageError     = "error"
)

// Existing：已有同地址的第三方供应商
type Existing struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Offer：视图看到的一条待确认（= ProviderLinkOffer）
type Offer struct {
	ID        string            `json:"id"`
	Stage     string            `json:"stage"`
	Source    string            `json:"source"`
	Issuer    string            `json:"issuer,omitempty"`
	Name      string            `json:"name"`
	Homepage  string            `json:"homepage,omitempty"`
	URLs      map[string]string `json:"urls"`
	KeyMasked string            `json:"keyMasked,omitempty"`
	Models    []string          `json:"models"`
	Existing  *Existing         `json:"existing,omitempty"`
	Error     string            `json:"error,omitempty"`
	CreatedAt int64             `json:"createdAt"`
	ExpiresAt int64             `json:"expiresAt"`
}

// AcceptResult = ProviderLinkAcceptResult
type AcceptResult struct {
	Stage      string `json:"stage"`
	ProviderID string `json:"providerId,omitempty"`
	Name       string `json:"name,omitempty"`
	Updated    *bool  `json:"updated,omitempty"`
}

// Error：错误码（bad_issuer、network …，以及 not_found / unavailable）
type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

// Gateway：网关服务里链接导入要用的两个方法（gwstore.Service）
type Gateway interface {
	FindProviderByURLs(urls []string) (id, name string, found bool)
	ImportLinkedProvider(p Provider) (*u.Obj, bool, error)
}

type Logger interface {
	Info(msg string, kv ...any)
	Warn(msg string, kv ...any)
}

type Deps struct {
	Gateway      func() Gateway
	OpenExternal func(url string) error
	// Publish：待确认列表变了（契约事件 providerLink.changed）
	Publish func(offers []Offer)
	// Reveal：有新的待确认，把对话窗口带到前台
	Reveal func()
	// AssertPublic：出站前校验主机解析出的地址都是公网（netGuard）
	AssertPublic func(url string) error
	HTTP         *http.Client
	Now          func() time.Time
	Logger       Logger
}

type offer struct {
	view     Offer
	provider *Provider
	manifest *Manifest
	sig      string
}

type session struct {
	verifier string
	manifest Manifest
	expires  time.Time
}

type Service struct {
	d        Deps
	mu       sync.Mutex
	offers   []*offer
	sessions map[string]*session
	order    []string
	seq      int
}

func New(d Deps) *Service {
	if d.HTTP == nil {
		d.HTTP = &http.Client{
			Timeout: fetchTimeout,
			// 不跟随跳转：跳转目标可能指向内网，也可能换了主机
			CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect") },
		}
	}
	return &Service{d: d, sessions: map[string]*session{}}
}

func (s *Service) now() time.Time {
	if s.d.Now != nil {
		return s.d.Now()
	}
	return time.Now()
}

// purge：调用方持锁；列表有变化返回 true
func (s *Service) purge() bool {
	now := s.now()
	for k, x := range s.sessions {
		if !x.expires.After(now) {
			delete(s.sessions, k)
		}
	}
	keep := s.offers[:0]
	changed := false
	for _, o := range s.offers {
		if o.view.ExpiresAt > now.UnixMilli() {
			keep = append(keep, o)
		} else {
			changed = true
		}
	}
	s.offers = keep
	return changed
}

func (s *Service) views() []Offer {
	out := make([]Offer, 0, len(s.offers))
	for _, o := range s.offers {
		out = append(out, o.view)
	}
	return out
}

// List = providerLink.list
func (s *Service) List() []Offer {
	s.mu.Lock()
	changed := s.purge()
	v := s.views()
	s.mu.Unlock()
	if changed && s.d.Publish != nil {
		s.d.Publish(v)
	}
	return v
}

func (s *Service) add(o *offer) {
	s.mu.Lock()
	s.purge()
	now := s.now().UnixMilli()
	keep := s.offers[:0]
	for _, x := range s.offers {
		if x.sig != o.sig {
			keep = append(keep, x)
		}
	}
	s.offers = keep
	o.view.ID = "pl_" + strconv.FormatInt(now, 36) + "_" + strconv.FormatInt(int64(s.seq), 36)
	s.seq++
	o.view.CreatedAt = now
	o.view.ExpiresAt = now + OfferTTL.Milliseconds()
	if o.view.URLs == nil {
		o.view.URLs = map[string]string{}
	}
	if o.view.Models == nil {
		o.view.Models = []string{}
	}
	s.offers = append(s.offers, o)
	for len(s.offers) > MaxOffers {
		s.offers = s.offers[1:]
	}
	v := s.views()
	s.mu.Unlock()
	if s.d.Publish != nil {
		s.d.Publish(v)
	}
	if s.d.Reveal != nil {
		s.d.Reveal()
	}
}

func hostOf(origin string) string {
	if u, err := gwnet.ParseURL(origin); err == nil {
		return u.Hostname()
	}
	return origin
}

func (s *Service) addError(code, issuer string) {
	if s.d.Logger != nil {
		s.d.Logger.Warn("第三方供应商链接无法处理", "code", code)
	}
	src, name := "link", ""
	if issuer != "" {
		src, name = "issuer", hostOf(issuer)
	}
	s.add(&offer{
		sig:  "error:" + code + ":" + issuer,
		view: Offer{Stage: stageError, Source: src, Issuer: issuer, Name: name, Error: code},
	})
}

func (s *Service) saveOffer(p Provider, source, issuer string) {
	var existing *Existing
	if s.d.Gateway != nil {
		if gw := s.d.Gateway(); gw != nil {
			if id, name, found := gw.FindProviderByURLs(urlsOf(p.URLs)); found {
				existing = &Existing{ID: id, Name: name}
			}
		}
	}
	sig, _ := json.Marshal([]any{p.Name, p.URLs, p.Key, p.Models})
	pc := p
	s.add(&offer{
		provider: &pc,
		sig:      "save:" + string(sig),
		view: Offer{
			Stage: stageSave, Source: source, Issuer: issuer, Name: p.Name, Homepage: p.Homepage,
			URLs: p.URLs, KeyMasked: MaskKey(p.Key), Models: p.Models, Existing: existing,
		},
	})
}

func urlsOf(m map[string]string) []string {
	out := []string{}
	for _, w := range Wires {
		if v := m[w]; v != "" {
			out = append(out, v)
		}
	}
	return out
}

var providerLinkRE = regexp.MustCompile(`(?i)^nomi://provider\b`)

// Receive：宿主收到的 `nomi://` 链接（不是 provider 的忽略）
func (s *Service) Receive(raw string) {
	if !providerLinkRE.MatchString(strings.TrimSpace(raw)) {
		return
	}
	r := ParseLink(raw)
	if !r.OK {
		s.addError(r.Code, "")
		return
	}
	link := *r.Value
	if s.d.Logger != nil {
		s.d.Logger.Info("收到第三方供应商链接", "kind", link.Kind)
	}
	switch link.Kind {
	case "import":
		s.saveOffer(*link.Provider, "link", "")
	case "connect":
		m, err := s.manifest(link.Issuer)
		if err != nil {
			s.addError(codeOf(err), link.Issuer)
			return
		}
		mc := m
		s.add(&offer{
			manifest: &mc,
			sig:      "authorize:" + m.Issuer,
			view: Offer{
				Stage: stageAuthorize, Source: "issuer", Issuer: m.Issuer, Name: m.Name,
				Homepage: m.Homepage, URLs: m.URLs, Models: m.Models,
			},
		})
	case "callback":
		s.mu.Lock()
		s.purge()
		sess := s.sessions[link.State]
		delete(s.sessions, link.State)
		s.mu.Unlock()
		if sess == nil {
			s.addError("bad_state", "")
			return
		}
		if link.Code == "" {
			s.addError("denied", sess.manifest.Issuer)
			return
		}
		raw, err := s.postForm(sess.manifest.TokenEndpoint, TokenRequestBody(link.Code, sess.verifier))
		if err != nil {
			s.addError(codeOf(err), sess.manifest.Issuer)
			return
		}
		p := ParseTokenResponse(raw, sess.manifest)
		if !p.OK {
			s.addError(p.Code, sess.manifest.Issuer)
			return
		}
		s.saveOffer(*p.Value, "issuer", sess.manifest.Issuer)
	}
}

// Connect = providerLink.connect：设置里填域名发起授权（用户自己发起，不再多确认一次）
func (s *Service) Connect(raw string) (map[string]string, error) {
	t := strings.TrimSpace(raw)
	if !(len(t) >= 8 && strings.EqualFold(t[:8], "https://")) {
		t = "https://" + t
	}
	issuer := NormalizeIssuer(t)
	if issuer == "" {
		return nil, &Error{"bad_issuer"}
	}
	m, err := s.manifest(issuer)
	if err != nil {
		return nil, err
	}
	if err := s.authorize(m); err != nil {
		return nil, err
	}
	return map[string]string{"name": m.Name, "issuer": m.Issuer}, nil
}

// Accept = providerLink.accept
func (s *Service) Accept(id string) (*AcceptResult, error) {
	s.mu.Lock()
	s.purge()
	var o *offer
	for _, x := range s.offers {
		if x.view.ID == id {
			o = x
		}
	}
	s.mu.Unlock()
	if o == nil {
		return nil, &Error{"not_found"}
	}
	switch {
	case o.view.Stage == stageAuthorize && o.manifest != nil:
		if err := s.authorize(*o.manifest); err != nil {
			return nil, err
		}
		s.Reject(id)
		return &AcceptResult{Stage: stageAuthorize, Name: o.view.Name}, nil
	case o.view.Stage == stageSave && o.provider != nil:
		var gw Gateway
		if s.d.Gateway != nil {
			gw = s.d.Gateway()
		}
		if gw == nil {
			return nil, &Error{"unavailable"}
		}
		view, updated, err := gw.ImportLinkedProvider(*o.provider)
		if err != nil {
			return nil, err
		}
		s.Reject(id)
		if s.d.Logger != nil {
			s.d.Logger.Info("已从链接保存第三方供应商", "updated", updated)
		}
		pid, _ := view.Get("id").(string)
		name, _ := view.Get("name").(string)
		return &AcceptResult{Stage: stageSave, ProviderID: pid, Name: name, Updated: &updated}, nil
	}
	s.Reject(id)
	return &AcceptResult{Stage: o.view.Stage}, nil
}

// Reject = providerLink.reject
func (s *Service) Reject(id string) {
	s.mu.Lock()
	keep := s.offers[:0]
	changed := false
	for _, x := range s.offers {
		if x.view.ID == id {
			changed = true
			continue
		}
		keep = append(keep, x)
	}
	s.offers = keep
	v := s.views()
	s.mu.Unlock()
	if changed && s.d.Publish != nil {
		s.d.Publish(v)
	}
}

func (s *Service) authorize(m Manifest) error {
	state, verifier, challenge := NewPKCE()
	s.mu.Lock()
	s.purge()
	// 未完成的授权最多留 5 个（先进先出）
	live := s.order[:0]
	for _, k := range s.order {
		if s.sessions[k] != nil {
			live = append(live, k)
		}
	}
	s.order = live
	for len(s.sessions) >= MaxOffers && len(s.order) > 0 {
		delete(s.sessions, s.order[0])
		s.order = s.order[1:]
	}
	s.sessions[state] = &session{verifier: verifier, manifest: m, expires: s.now().Add(OfferTTL)}
	s.order = append(s.order, state)
	s.mu.Unlock()
	if s.d.OpenExternal == nil {
		return &Error{"unavailable"}
	}
	return s.d.OpenExternal(AuthorizeURL(m, state, challenge))
}

func (s *Service) manifest(issuer string) (Manifest, error) {
	raw, err := s.request(http.MethodGet, issuer+"/.well-known/nomi-provider.json", "", "bad_manifest")
	if err != nil {
		return Manifest{}, err
	}
	m := ParseManifest(raw, issuer)
	if !m.OK {
		return Manifest{}, &Error{m.Code}
	}
	return *m.Value, nil
}

func (s *Service) postForm(endpoint, body string) (any, error) {
	return s.request(http.MethodPost, endpoint, body, "bad_token")
}

func (s *Service) request(method, target, body, bad string) (any, error) {
	if s.d.AssertPublic != nil {
		if err := s.d.AssertPublic(target); err != nil {
			if bad == "bad_manifest" {
				return nil, &Error{"bad_issuer"}
			}
			return nil, &Error{bad}
		}
	}
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, target, rd)
	if err != nil {
		return nil, &Error{"network"}
	}
	req.Header.Set("Accept", "application/json")
	if body != "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, err := s.d.HTTP.Do(req)
	if err != nil {
		return nil, &Error{"network"}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &Error{bad}
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, &Error{"network"}
	}
	if len(b) > maxBody {
		return nil, &Error{bad}
	}
	var v any
	if json.Unmarshal(b, &v) != nil {
		return nil, &Error{bad}
	}
	return v, nil
}

func codeOf(err error) string {
	var e *Error
	if errors.As(err, &e) && e.Code != "not_found" && e.Code != "unavailable" {
		return e.Code
	}
	return "network"
}
