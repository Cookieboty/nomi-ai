package viewpage

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
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

func TestHostScript(t *testing.T) {
	if got := string(Patch([]byte(page), false)); !strings.Contains(got, hostTag) {
		t.Fatalf("host script tag missing:\n%s", got)
	}
	h := Middleware(fstest.MapFS{})(http.NotFoundHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", HostScriptPath, nil))
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") ||
		!strings.Contains(rec.Body.String(), OpenExternalPrefix) {
		t.Fatalf("host script not served: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

// 宿主脚本的点击处理在捕获阶段：视图自己打开的链接（data-resource-preview）不再转给宿主，
// 否则对话里点一个网址会打开两次；普通跨源链接照常转给宿主，同源链接不管
func TestHostScriptSkipsViewHandledLinks(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	harness := `
const posted = [];
let onClick;
globalThis.location = { href: 'http://127.0.0.1:1234/chat/index.html', origin: 'http://127.0.0.1:1234' };
globalThis.webkit = { messageHandlers: { external: { postMessage: (m) => posted.push(m) } } };
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn, capture) => { if (type === 'click' && capture) onClick = fn; };
` + hostScript + `
const click = (href, attrs = {}) => {
  const a = { getAttribute: () => href, hasAttribute: (n) => n in attrs };
  const e = { target: { closest: () => a }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  onClick(e);
  return e.defaultPrevented;
};
const r = {
  handled: click('https://example.com/a', { 'data-resource-preview': 'true' }),
  plain: click('https://example.com/b'),
  same: click('/chat/other'),
};
console.log(JSON.stringify({ r, posted }));
`
	out, err := exec.Command(node, "-e", harness).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	want := `{"r":{"handled":false,"plain":true,"same":false},"posted":["` + OpenExternalPrefix + `https://example.com/b"]}`
	if got := strings.TrimSpace(string(out)); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
