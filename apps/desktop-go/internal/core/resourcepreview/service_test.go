package resourcepreview

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewFileCapabilitiesAndRange(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "picture.png")
	_ = os.WriteFile(p, []byte("0123456789"), 0600)
	s := New()
	res := s.Open(dir, p, "/nonexistent-home", false)
	if !res.OK || res.Kind != "image" {
		t.Fatalf("open: %+v", res)
	}
	h := s.Middleware(http.NotFoundHandler())
	r := httptest.NewRequest("GET", res.URL, nil)
	r.Header.Set("Range", "bytes=2-5")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "2345" {
		t.Fatalf("range: %d %q", w.Code, w.Body.String())
	}
	s.Close(res.URL)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", res.URL, nil))
	if w.Code != 404 {
		t.Fatal("revoked capability remained valid")
	}
}
func TestPreviewOutsideRequiresFileConsentAndRejectsSensitiveFiles(t *testing.T) {
	dir := t.TempDir()
	inside := filepath.Join(dir, "project")
	_ = os.Mkdir(inside, 0700)
	p := filepath.Join(dir, "notes.md")
	_ = os.WriteFile(p, []byte("# Notes"), 0600)
	s := New()
	if r := s.Open(inside, p, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatalf("outside: %+v", r)
	}
	if r := s.Open(inside, p, "/nonexistent-home", true); !r.OK {
		t.Fatalf("explicit file consent: %+v", r)
	}
	secret := filepath.Join(dir, ".ssh", "id_rsa")
	_ = os.Mkdir(filepath.Dir(secret), 0700)
	_ = os.WriteFile(secret, []byte("private"), 0600)
	if r := s.Open(inside, secret, "/nonexistent-home", true); r.Code != "denied" {
		t.Fatalf("protected file: %+v", r)
	}
}
func TestPreviewSymlinkEscapeAndReplacement(t *testing.T) {
	dir := t.TempDir()
	work := filepath.Join(dir, "project")
	_ = os.Mkdir(work, 0700)
	outside := filepath.Join(dir, "outside.txt")
	_ = os.WriteFile(outside, []byte("outside"), 0600)
	link := filepath.Join(work, "link.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip(err)
	}
	s := New()
	if r := s.Open(work, link, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatal("symlink escaped workspace")
	}
	p := filepath.Join(work, "inside.txt")
	_ = os.WriteFile(p, []byte("inside"), 0600)
	res := s.Open(work, p, "/nonexistent-home", false)
	replacement := filepath.Join(work, "new.txt")
	_ = os.WriteFile(replacement, []byte("new"), 0600)
	_ = os.Rename(replacement, p)
	w := httptest.NewRecorder()
	s.Middleware(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest("GET", res.URL, nil))
	if w.Code != 404 {
		t.Fatal("replacement reused existing grant")
	}
}
func TestPreviewElidedPathMustBeUnique(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a", "src", "note.md")
	_ = os.MkdirAll(filepath.Dir(p), 0700)
	_ = os.WriteFile(p, []byte("# Note"), 0600)
	s := New()
	if r := s.Open(dir, ".../src/note.md", "/nonexistent-home", false); !r.OK {
		t.Fatalf("unique suffix: %+v", r)
	}
	other := filepath.Join(dir, "b", "src", "note.md")
	_ = os.MkdirAll(filepath.Dir(other), 0700)
	_ = os.WriteFile(other, []byte("different"), 0600)
	if r := s.Open(dir, ".../src/note.md", "/nonexistent-home", false); r.Code != "ambiguous" {
		t.Fatal("ambiguous suffix was guessed")
	}
}
func TestWebRejectsLocalAddresses(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1/secret", "http://localhost/secret", "file:///etc/passwd", "http://169.254.169.254/latest/meta-data"} {
		if r := New().Web(u); r.OK {
			t.Fatalf("unsafe URL: %s", u)
		}
	}
}

func TestExternalHTMLUsesIsolatedOriginWithApprovedAssets(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "page.html"), []byte(`<html><script src="app.js"></script><h1>page</h1></html>`), 0600)
	_ = os.WriteFile(filepath.Join(dir, "app.js"), []byte(`document.body.dataset.loaded="yes"`), 0600)
	s := New()
	defer s.Shutdown()
	res := s.Open(dir, "page.html", "/nonexistent-home", false)
	if !res.OK || !strings.HasPrefix(res.BrowserURL, "http://127.0.0.1:") {
		t.Fatalf("isolated browser: %+v", res)
	}
	response, err := http.Get(res.BrowserURL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !strings.Contains(response.Header.Get("Content-Security-Policy"), "allow-scripts") {
		t.Fatal("local browser not enabled")
	}
	assets := res.BrowserURL[:strings.LastIndex(res.BrowserURL, "/")+1] + "app.js"
	a, err := http.Get(assets)
	if err != nil {
		t.Fatal(err)
	}
	a.Body.Close()
	if a.StatusCode != 200 {
		t.Fatal("approved adjacent asset missing")
	}
	secret := res.BrowserURL[:strings.LastIndex(res.BrowserURL, "/")+1] + "../outside.txt"
	r, err := http.Get(secret)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 404 {
		t.Fatal("browser traversal accepted")
	}
	s.Close(res.URL)
	r, err = http.Get(res.BrowserURL)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 404 {
		t.Fatal("closed HTML still served")
	}
}
