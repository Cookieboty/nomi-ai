package viewpage

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const page = `<!doctype html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob: data: character-pack:; media-src 'self'" />
<script type="module" crossorigin src="./assets/main.js"></script>
</head><body></body></html>`

func TestPatchWidensCSPAndAddsRuntime(t *testing.T) {
	got := string(Patch([]byte(page), false))
	if !strings.Contains(got, "connect-src 'self' blob: data: character-pack: ws://127.0.0.1:*; media-src") {
		t.Fatalf("connect-src not widened:\n%s", got)
	}
	if !strings.Contains(got, RuntimeTag+"\n</head>") {
		t.Fatalf("runtime not inserted:\n%s", got)
	}
	if strings.Contains(got, LogPrefix) {
		t.Fatal("console forwarding must be dev-only")
	}
	// 只改写一次
	if again := string(Patch([]byte(got), false)); again != got {
		t.Fatal("patch is not idempotent")
	}
}

func TestPatchDevAddsConsoleForwarding(t *testing.T) {
	got := string(Patch([]byte("<html><head></head></html>"), true))
	if !strings.Contains(got, LogPrefix) || !strings.Contains(got, RuntimeTag) {
		t.Fatalf("dev patch incomplete:\n%s", got)
	}
}

func TestPatchCSPAtEndOfContent(t *testing.T) {
	in := `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'"/></head>`
	got := string(Patch([]byte(in), false))
	if !strings.Contains(got, `connect-src 'self' ws://127.0.0.1:*"`) {
		t.Fatalf("got %s", got)
	}
}

func TestMiddleware(t *testing.T) {
	assets := fstest.MapFS{"mascot/index.html": {Data: []byte(page)}}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("next")) })
	h := Middleware(assets, "/mascot/index.html")(next)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/mascot/index.html", nil))
	if !strings.Contains(rec.Body.String(), RuntimeTag) || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("page not patched: %q", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/mascot/assets/main.js", nil))
	if rec.Body.String() != "next" {
		t.Fatalf("other paths should fall through: %q", rec.Body.String())
	}
}
