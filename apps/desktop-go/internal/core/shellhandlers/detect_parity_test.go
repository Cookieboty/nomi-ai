package shellhandlers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/probe"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type detectRule struct {
	M, U, Body, Auth, Key string
	Status                int
}

type detectScenario struct {
	Name          string       `json:"name"`
	URL           string       `json:"url"`
	Keys          []string     `json:"keys"`
	FallbackModel string       `json:"fallbackModel"`
	Allowed       []string     `json:"allowed"`
	Throw         string       `json:"throw"`
	Rules         []detectRule `json:"rules"`
	Out           any          `json:"out"`
	Bases         any          `json:"bases"`
	Reqs          [][]any      `json:"reqs"`
}

func reqAuth(h http.Header) (string, string) {
	if a := h.Get("Authorization"); a != "" {
		return "bearer", strings.TrimPrefix(a, "Bearer ")
	}
	if a := h.Get("x-api-key"); a != "" {
		return "x-api-key", a
	}
	if a := h.Get("x-goog-api-key"); a != "" {
		return "x-goog-api-key", a
	}
	return "none", ""
}

func TestDetectParity(t *testing.T) {
	var g struct{ Scenarios []detectScenario }
	loadGolden(t, "shell_detect.json", &g)
	for _, sc := range g.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			var mu sync.Mutex
			reqs := [][]any{}
			fetch := func(req *http.Request) (*http.Response, error) {
				auth, key := reqAuth(req.Header)
				var body any
				if req.Body != nil {
					b, _ := io.ReadAll(req.Body)
					body = string(b)
				}
				mu.Lock()
				reqs = append(reqs, []any{req.Method, req.URL.String(), auth, key, body})
				mu.Unlock()
				if sc.Throw != "" {
					return nil, errors.New(sc.Throw)
				}
				st, rb := 404, ""
				for _, r := range sc.Rules {
					if r.M == req.Method && strings.Contains(req.URL.String(), r.U) && (r.Auth == "" || r.Auth == auth) && (r.Key == "" || r.Key == key) {
						st, rb = r.Status, r.Body
						break
					}
				}
				return &http.Response{StatusCode: st, Body: io.NopCloser(strings.NewReader(rb)), Header: http.Header{}}, nil
			}
			bases := probe.NormalizeBases(sc.URL)
			if got := rawAny([]byte(u.Stringify(bases))); !jsonEq(got, sc.Bases) {
				t.Errorf("normalizeBases = %v want %v", got, sc.Bases)
			}
			o := probe.Options{Bases: bases, FallbackModel: sc.FallbackModel, AllowedPrivateHosts: sc.Allowed,
				FetchImpl: fetch, Now: func() float64 { return 0 },
				LookupAll: func(context.Context, string) ([]net.LookupAddress, error) {
					return []net.LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
				}}
			for i, k := range sc.Keys {
				o.Keys = append(o.Keys, probe.Key{ID: "key" + string(rune('0'+i)), Value: k})
			}
			out := probe.Detect(o)
			if got := rawAny([]byte(u.Stringify(out))); !jsonEq(got, sc.Out) {
				t.Errorf("detect out:\n got %s\nwant %s", u.Stringify(out), mustJSON(sc.Out))
			}
			keyOf := func(r []any) string { return mustJSON(r) }
			sort.Slice(reqs, func(i, j int) bool { return keyOf(reqs[i]) < keyOf(reqs[j]) })
			got := rawAny([]byte(mustJSON(reqs)))
			if !jsonEq(got, rawAny([]byte(mustJSON(sc.Reqs)))) {
				t.Errorf("requests:\n got %s\nwant %s", mustJSON(reqs), mustJSON(sc.Reqs))
			}
		})
	}
}

// mustJSON = JSON.stringify（不转义 <>&）
func mustJSON(v any) string {
	var b strings.Builder
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	return strings.TrimSuffix(b.String(), "\n")
}
