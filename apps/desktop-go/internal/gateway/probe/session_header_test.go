package probe

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestProbeSessionHeader(t *testing.T) {
	lookup := func(context.Context, string) ([]net.LookupAddress, error) {
		return []net.LookupAddress{{Address: "93.184.216.34", Family: 4}}, nil
	}
	resp := func(req *http.Request, status int, body string) *http.Response {
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    req,
		}
	}

	var mu sync.Mutex
	seen := map[string]string{}
	fetch := func(req *http.Request) (*http.Response, error) {
		if req.Method == "GET" && strings.HasSuffix(req.URL.Path, "/models") {
			return resp(req, 200, `{"data":[{"id":"kimi-k3"}]}`), nil
		}
		h := ""
		for k, vs := range req.Header {
			if strings.EqualFold(k, "x-opencode-session") && len(vs) > 0 {
				h = vs[0]
			}
		}
		mu.Lock()
		seen[req.URL.Path] = h
		mu.Unlock()
		if h == "" {
			return resp(req, 400, "missing x-opencode-session"), nil
		}
		return resp(req, 200, `{"id":"ok"}`), nil
	}

	bases := u.NewObj(
		"chat", "https://opencode.example.test/inference/go/openai/v1",
		"responses", "https://opencode.example.test/inference/go/openai/v1",
		"messages", "https://opencode.example.test/inference/go/anthropic/v1",
	)

	r := Detect(Options{
		Bases:         bases,
		Keys:          []Key{{ID: "k", Value: "sk-test"}},
		SessionHeader: "x-opencode-session",
		FetchImpl:     fetch,
		LookupAll:     lookup,
	})
	wires := r.Get("wires").(*u.Obj)
	for _, w := range []string{"chat", "responses", "messages"} {
		ln := wires.Get(w).(*u.Obj)
		if ln.Get("ok") != true {
			t.Fatalf("%s probe failed with session header: %s", w, u.Stringify(ln))
		}
	}
	mu.Lock()
	cSess := seen["/inference/go/openai/v1/chat/completions"]
	rSess := seen["/inference/go/openai/v1/responses"]
	mSess := seen["/inference/go/anthropic/v1/messages"]
	mu.Unlock()
	if cSess == "" || cSess != rSess || cSess != mSess {
		t.Fatalf("expected all probed wires to share one non-empty session header, got chat=%q responses=%q messages=%q", cSess, rSess, mSess)
	}

	// 未配置 SessionHeader 时，不发送该请求头
	mu.Lock()
	seen = map[string]string{}
	mu.Unlock()
	r2 := Detect(Options{
		Bases:     u.NewObj("chat", "https://opencode.example.test/inference/go/openai/v1"),
		Keys:      []Key{{ID: "k", Value: "sk-test"}},
		FetchImpl: fetch,
		LookupAll: lookup,
	})
	if ln := r2.Get("wires").(*u.Obj).Get("chat").(*u.Obj); ln.Get("ok") == true {
		t.Fatalf("expected probe without session header to fail 400 plain-text check, got %s", u.Stringify(ln))
	}
	if seen["/inference/go/openai/v1/chat/completions"] != "" {
		t.Fatalf("must not send x-opencode-session when SessionHeader is empty: %v", seen)
	}
}
