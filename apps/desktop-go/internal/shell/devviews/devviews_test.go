package devviews

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell/viewpage"
)

func TestParse(t *testing.T) {
	got, err := Parse("mascot=http://127.0.0.1:6127, chat=http://127.0.0.1:6128")
	if err != nil || len(got) != 2 || got["mascot"].Host != "127.0.0.1:6127" || got["chat"].Host != "127.0.0.1:6128" {
		t.Fatalf("got %v %v", got, err)
	}
	for _, bad := range []string{"mascot", "mascot=https://127.0.0.1:1", "mascot=http://10.0.0.1:1", "a/b=http://127.0.0.1:1", "=http://127.0.0.1:1"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}

func TestMiddlewareProxiesAndInjectsRuntime(t *testing.T) {
	var gotHost, gotPath string
	vite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotPath = r.Host, r.URL.Path
		if strings.HasSuffix(r.URL.Path, "/") {
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "<html><head><title>x</title></head><body></body></html>")
			return
		}
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = io.WriteString(w, "export {}")
	}))
	defer vite.Close()
	u, _ := url.Parse(vite.URL)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "embedded") })
	h := Middleware(map[string]*url.URL{"mascot": u})(next)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/mascot/", nil))
	if gotHost != u.Host || gotPath != "/mascot/" {
		t.Fatalf("proxied host=%q path=%q", gotHost, gotPath)
	}
	if body := rec.Body.String(); !strings.Contains(body, viewpage.RuntimeTag+"\n</head>") || !strings.Contains(body, viewpage.LogPrefix) {
		t.Fatalf("runtime not injected: %s", body)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/mascot/src/index.tsx", nil))
	if rec.Body.String() != "export {}" {
		t.Fatalf("js body changed: %q", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://wails.localhost/__scheme/chat-asset/a.png", nil))
	if rec.Body.String() != "embedded" {
		t.Fatalf("non-view path should fall through, got %q", rec.Body.String())
	}
}
