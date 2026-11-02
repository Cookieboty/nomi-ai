package hostdrop

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func serve(s *Store) http.Handler {
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	return s.Middleware(func(h http.Handler) http.Handler { return h })(fallback)
}

func get(h http.Handler, url string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestAddServesEachDroppedFileOnce(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "cat.png")
	if err := os.WriteFile(img, []byte("png-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := New()
	es := s.Add([]string{img, dir, filepath.Join(dir, "missing.txt")})
	if len(es) != 3 {
		t.Fatalf("entries = %d", len(es))
	}
	if es[0].Path != img || es[0].Size != int64(len("png-bytes")) || es[0].URL == "" {
		t.Fatalf("file entry = %+v", es[0])
	}
	// 目录、不存在的文件：只给路径，没有临时地址
	if es[1].URL != "" || es[2].URL != "" {
		t.Fatalf("dir / missing should have no url: %+v %+v", es[1], es[2])
	}
	h := serve(s)
	rec := get(h, es[0].URL)
	body, _ := io.ReadAll(rec.Body)
	if rec.Code != http.StatusOK || string(body) != "png-bytes" {
		t.Fatalf("first read: %d %q", rec.Code, body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("must not be cached")
	}
	// 一次性：再读就 404
	if rec := get(h, es[0].URL); rec.Code != http.StatusNotFound {
		t.Fatalf("second read = %d", rec.Code)
	}
}

func TestTokensExpireAndUnknownTokensAre404(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_800_000_000, 0)
	s := New()
	s.now = func() time.Time { return now }
	e := s.Add([]string{f})[0]
	now = now.Add(TTL + time.Second)
	h := serve(s)
	if rec := get(h, e.URL); rec.Code != http.StatusNotFound {
		t.Fatalf("expired = %d", rec.Code)
	}
	if rec := get(h, Prefix+"deadbeef"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown = %d", rec.Code)
	}
	// 其它路径交给下一层
	if rec := get(h, "/chat/index.html"); rec.Code != http.StatusTeapot {
		t.Fatalf("passthrough = %d", rec.Code)
	}
}
