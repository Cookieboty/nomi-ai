package assetproto

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestServeBuiltinPack(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "rive"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "rive", "a b.riv"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(root), "secret.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	get := func(rel string, hdr map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		for k, v := range hdr {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		ServeBuiltinPack(w, r, root, rel)
		return w
	}

	w := get("rive/a%20b.riv", nil)
	if w.Code != http.StatusOK || w.Body.String() != "0123456789" || w.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("full: %d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
	}
	if w = get("rive/a%20b.riv", map[string]string{"Range": "bytes=2-4"}); w.Code != http.StatusPartialContent || w.Body.String() != "234" {
		t.Fatalf("range: %d %q", w.Code, w.Body.String())
	}
	for _, rel := range []string{"", "rive", "missing.png", "../secret.txt", "rive/%2e%2e/%2e%2e/secret.txt", "..%2fsecret.txt"} {
		if w = get(rel, nil); w.Code != http.StatusNotFound {
			t.Errorf("%q: want 404, got %d", rel, w.Code)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	w = httptest.NewRecorder()
	ServeBuiltinPack(w, r, "", "rive/a%20b.riv")
	if w.Code != http.StatusNotFound {
		t.Errorf("no pack: want 404, got %d", w.Code)
	}
}
