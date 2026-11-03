package providerlink

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type fakeGW struct {
	mu    sync.Mutex
	saved []Provider
}

func (g *fakeGW) FindProviderByURLs(urls []string) (string, string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, p := range g.saved {
		for _, have := range p.URLs {
			for _, v := range urls {
				if SameURL(have, v) {
					return "p1", p.Name, true
				}
			}
		}
	}
	return "", "", false
}

func (g *fakeGW) ImportLinkedProvider(p Provider) (*u.Obj, bool, error) {
	_, _, found := g.FindProviderByURLs(urlsOf(p.URLs))
	g.mu.Lock()
	g.saved = append(g.saved, p)
	g.mu.Unlock()
	return u.NewObj("id", "p1", "name", p.Name), found, nil
}

type rt func(*http.Request) (*http.Response, error)

func (f rt) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func resp(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

type harness struct {
	svc       *Service
	gw        *fakeGW
	published [][]Offer
	opened    []string
	reqs      []*http.Request
	bodies    []string
}

func newHarness(handler func(*http.Request) *http.Response, now func() time.Time) *harness {
	h := &harness{gw: &fakeGW{}}
	h.svc = New(Deps{
		Gateway:      func() Gateway { return h.gw },
		OpenExternal: func(u string) error { h.opened = append(h.opened, u); return nil },
		Publish:      func(o []Offer) { h.published = append(h.published, o) },
		AssertPublic: func(string) error { return nil },
		HTTP: &http.Client{Transport: rt(func(r *http.Request) (*http.Response, error) {
			h.reqs = append(h.reqs, r)
			b := ""
			if r.Body != nil {
				bb, _ := io.ReadAll(r.Body)
				b = string(bb)
			}
			h.bodies = append(h.bodies, b)
			if handler == nil {
				return resp(404, ""), nil
			}
			return handler(r), nil
		})},
		Now: now,
	})
	return h
}

func importURL(v any) string {
	b, _ := json.Marshal(v)
	return "nomi://provider/import?v=1&data=" + base64.RawURLEncoding.EncodeToString(b)
}

func TestImportFlow(t *testing.T) {
	h := newHarness(nil, nil)
	h.svc.Receive(importURL(map[string]any{
		"name": "Example AI", "urls": map[string]any{"chat": "https://api.example.com/v1"},
		"key": "sk-abcdefghijklmnop", "models": []any{"gpt-5"},
	}))
	list := h.svc.List()
	if len(list) != 1 || list[0].Stage != "save" || list[0].KeyMasked != "sk-…mnop" || list[0].Source != "link" {
		t.Fatalf("%+v", list)
	}
	pub, _ := json.Marshal(h.published)
	if strings.Contains(string(pub), "sk-abcdefghijklmnop") {
		t.Fatal("key leaked to view")
	}
	r, err := h.svc.Accept(list[0].ID)
	if err != nil || r.Stage != "save" || r.ProviderID != "p1" || *r.Updated {
		t.Fatal(err, r)
	}
	if len(h.svc.List()) != 0 || len(h.gw.saved) != 1 {
		t.Fatal("not saved / not removed")
	}
	// 同地址再来：existing
	h.svc.Receive(importURL(map[string]any{
		"name": "X", "urls": map[string]any{"chat": "https://api.example.com/v1/"}, "key": "sk-zzzzzzzzzzzz",
	}))
	if e := h.svc.List()[0].Existing; e == nil || e.Name != "Example AI" {
		t.Fatalf("existing %+v", e)
	}
}

func TestErrorsDedupeLimitExpiry(t *testing.T) {
	now := time.UnixMilli(1000)
	h := newHarness(nil, func() time.Time { return now })
	h.svc.Receive("nomi://provider/import?v=1&data=%%%")
	if l := h.svc.List(); len(l) != 1 || l[0].Stage != "error" || l[0].Error != "bad_payload" {
		t.Fatalf("%+v", l)
	}
	h.svc.Reject(h.svc.List()[0].ID)
	p := map[string]any{"name": "A", "urls": map[string]any{"chat": "https://a.example.com"}, "key": "sk-1234567890"}
	h.svc.Receive(importURL(p))
	h.svc.Receive(importURL(p))
	if len(h.svc.List()) != 1 {
		t.Fatal("dedupe")
	}
	for i := 0; i < 6; i++ {
		p["name"] = string(rune('B' + i))
		h.svc.Receive(importURL(p))
	}
	if len(h.svc.List()) != MaxOffers {
		t.Fatal("limit")
	}
	now = now.Add(OfferTTL + time.Millisecond)
	if len(h.svc.List()) != 0 {
		t.Fatal("expiry")
	}
	h.svc.Receive("nomi://chat/open")
	if len(h.svc.List()) != 0 {
		t.Fatal("non-provider link")
	}
}

func TestAuthorizeFlow(t *testing.T) {
	h := newHarness(func(r *http.Request) *http.Response {
		switch r.URL.String() {
		case "https://example.com/.well-known/nomi-provider.json":
			return resp(200, `{"version":1,"name":"Example AI","urls":{"messages":"https://api.example.com"},
				"authorization_endpoint":"https://example.com/nomi/authorize","token_endpoint":"https://api.example.com/nomi/token"}`)
		case "https://api.example.com/nomi/token":
			return resp(200, `{"api_key":"sk-fromtoken12345"}`)
		}
		return resp(404, "")
	}, nil)
	h.svc.Receive("nomi://provider/connect?v=1&issuer=https://example.com")
	auth := h.svc.List()
	if len(auth) != 1 || auth[0].Stage != "authorize" || auth[0].Issuer != "https://example.com" || len(h.opened) != 0 {
		t.Fatalf("%+v %v", auth, h.opened)
	}
	if _, err := h.svc.Accept(auth[0].ID); err != nil {
		t.Fatal(err)
	}
	au, _ := url.Parse(h.opened[0])
	q := au.Query()
	if au.Host != "example.com" || q.Get("redirect_uri") != RedirectURI || q.Get("code_challenge_method") != "S256" {
		t.Fatal(h.opened[0])
	}
	state := q.Get("state")
	h.svc.Receive("nomi://provider/callback?code=the-code&state=" + state)
	form, _ := url.ParseQuery(h.bodies[len(h.bodies)-1])
	if form.Get("code") != "the-code" || PKCEChallenge(form.Get("code_verifier")) != q.Get("code_challenge") {
		t.Fatalf("form %v", form)
	}
	save := h.svc.List()
	if len(save) != 1 || save[0].Stage != "save" || save[0].Source != "issuer" || save[0].KeyMasked != "sk-…2345" {
		t.Fatalf("%+v", save)
	}
	if _, err := h.svc.Accept(save[0].ID); err != nil || h.gw.saved[0].URLs["messages"] != "https://api.example.com" {
		t.Fatal(err)
	}
	// state 只能用一次
	h.svc.Receive("nomi://provider/callback?code=the-code&state=" + state)
	if l := h.svc.List(); len(l) != 1 || l[0].Error != "bad_state" {
		t.Fatalf("%+v", l)
	}
}

func TestDeniedNetworkBadManifest(t *testing.T) {
	status := 200
	h := newHarness(func(r *http.Request) *http.Response {
		if status == 0 {
			return nil
		}
		return resp(status, `{"authorization_endpoint":"https://example.com/a","token_endpoint":"https://example.com/t"}`)
	}, nil)
	h.svc.d.HTTP.Transport = rt(func(r *http.Request) (*http.Response, error) {
		if status == 0 {
			return nil, io.ErrUnexpectedEOF
		}
		return resp(status, `{"authorization_endpoint":"https://example.com/a","token_endpoint":"https://example.com/t"}`), nil
	})
	if _, err := h.svc.Connect("example.com"); err != nil {
		t.Fatal(err)
	}
	state, _ := url.Parse(h.opened[0])
	h.svc.Receive("nomi://provider/callback?error=access_denied&state=" + state.Query().Get("state"))
	if l := h.svc.List(); l[len(l)-1].Error != "denied" {
		t.Fatalf("%+v", l)
	}
	status = 0
	h.svc.Receive("nomi://provider/connect?issuer=https://down.example.com")
	if l := h.svc.List(); l[len(l)-1].Error != "network" {
		t.Fatalf("%+v", l)
	}
	status = 500
	h.svc.Receive("nomi://provider/connect?issuer=https://broken.example.com")
	if l := h.svc.List(); l[len(l)-1].Error != "bad_manifest" {
		t.Fatalf("%+v", l)
	}
	if _, err := h.svc.Connect("http://example.com"); err == nil || err.(*Error).Code != "bad_issuer" {
		t.Fatal(err)
	}
}

// 授权网站解析到本机 / 局域网 → private_host（不再误报 bad_issuer）；解析失败 → network
func TestAssertPublicCodes(t *testing.T) {
	h := newHarness(nil, nil)
	code := "private_host"
	h.svc.d.AssertPublic = func(string) error { return &Error{code} }
	h.svc.Receive("nomi://provider/connect?issuer=https://intranet.example.com")
	if l := h.svc.List(); l[len(l)-1].Error != "private_host" {
		t.Fatalf("%+v", l)
	}
	code = "network"
	h.svc.Receive("nomi://provider/connect?issuer=https://nxdomain.example.com")
	if l := h.svc.List(); l[len(l)-1].Error != "network" {
		t.Fatalf("%+v", l)
	}
}
