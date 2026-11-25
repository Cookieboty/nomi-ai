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
func TestPreviewOutsideRequiresFileConsentAndAllowsSensitiveFiles(t *testing.T) {
	dir := t.TempDir()
	inside := filepath.Join(dir, "project")
	_ = os.Mkdir(inside, 0700)
	p := filepath.Join(dir, "notes.md")
	_ = os.WriteFile(p, []byte("# Notes"), 0600)
	s := New()
	if r := s.Open(inside, p, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatalf("outside: %+v", r)
	}
	if r := s.Open(inside, p, "/nonexistent-home", true); !r.OK || r.Editable {
		t.Fatalf("explicit file consent: %+v", r)
	}
	secret := filepath.Join(dir, ".ssh", "id_rsa")
	_ = os.Mkdir(filepath.Dir(secret), 0700)
	_ = os.WriteFile(secret, []byte("private"), 0600)
	if r := s.Open(inside, secret, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatalf("outside sensitive file without consent: %+v", r)
	}
	if r := s.Open(inside, secret, "/nonexistent-home", true); !r.OK || r.Editable || r.Content != "private" {
		t.Fatalf("outside sensitive file with consent: %+v", r)
	}
	dotenv := filepath.Join(inside, ".env")
	_ = os.WriteFile(dotenv, []byte("TOKEN=1\n"), 0600)
	envRes := s.Open(inside, dotenv, "/nonexistent-home", false)
	if !envRes.OK || !envRes.Editable || envRes.Content != "TOKEN=1\n" {
		t.Fatalf("workspace .env file: %+v", envRes)
	}
	if saved := s.Save(envRes.URL, envRes.Revision, "TOKEN=2\n"); !saved.OK {
		t.Fatalf("save workspace .env: %+v", saved)
	}
	if b, _ := os.ReadFile(dotenv); string(b) != "TOKEN=2\n" {
		t.Fatalf("saved .env disk content: %q", b)
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

func TestBlocksCrossOriginEmbed(t *testing.T) {
	deny := http.Header{"X-Frame-Options": []string{"SAMEORIGIN"}}
	if !blocksCrossOriginEmbed(deny) {
		t.Fatal("expected SAMEORIGIN to block cross-origin iframe embed")
	}
	cspSelf := http.Header{"Content-Security-Policy": []string{"default-src 'self'; frame-ancestors 'self' https://*.google.com"}}
	if !blocksCrossOriginEmbed(cspSelf) {
		t.Fatal("expected restrictive frame-ancestors to block cross-origin iframe embed")
	}
	cspWildcard := http.Header{"Content-Security-Policy": []string{"frame-ancestors *"}}
	if blocksCrossOriginEmbed(cspWildcard) {
		t.Fatal("wildcard frame-ancestors should allow embed")
	}
	allow := http.Header{"Content-Type": []string{"text/html"}}
	if blocksCrossOriginEmbed(allow) {
		t.Fatal("plain HTML without frame restrictions should allow embed")
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

func TestUniqueSuffixSkipsIgnoredDirectories(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	if err := os.MkdirAll(filepath.Join(work, "node_modules", "pkg"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "node_modules", "pkg", "wails.go"), []byte("package ignored\n"), 0644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(work, "apps", "shell", "wails.go")
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("package shell\n"), 0644); err != nil {
		t.Fatal(err)
	}
	s := New()
	res := s.Open(work, ".../wails.go", home, false)
	if !res.OK || res.Content != "package shell\n" {
		t.Fatalf("expected unique suffix match in apps/shell/wails.go, got %+v", res)
	}
}

func TestPreviewRelativePathStripsDuplicateRootName(t *testing.T) {
	parent := t.TempDir()
	work := filepath.Join(parent, "xy-token-api")
	if err := os.MkdirAll(filepath.Join(work, "xy-token-api"), 0755); err != nil {
		t.Fatal(err)
	}
	rootDoc := filepath.Join(work, "ERRORCODE-ENUM-AUDIT-20261119.md")
	nestedSameName := filepath.Join(work, "xy-token-api", "a.md")
	if err := os.WriteFile(rootDoc, []byte("# audit\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nestedSameName, []byte("# nested real\n"), 0644); err != nil {
		t.Fatal(err)
	}

	s := New()
	// 1. 首段与工作区根目录名重复时，直拼不到则剥除首段再拼当前工作区
	res := s.Open(work, "xy-token-api/ERRORCODE-ENUM-AUDIT-20261119.md", "/nonexistent-home", false)
	if !res.OK || res.Content != "# audit\n" {
		t.Fatalf("expected duplicate root prefix to resolve root doc, got %+v", res)
	}
	// 2. 若真实存在同名子目录文件，仍优先命中直拼结果
	realRes := s.Open(work, "xy-token-api/a.md", "/nonexistent-home", false)
	if !realRes.OK || realRes.Content != "# nested real\n" {
		t.Fatalf("expected real nested dir file to take priority, got %+v", realRes)
	}
	// 3. 剥除后依然不存在的文件应返回 missing
	missingRes := s.Open(work, "xy-token-api/nonexistent.md", "/nonexistent-home", false)
	if missingRes.OK || missingRes.Code != "missing" {
		t.Fatalf("expected missing for absent file, got %+v", missingRes)
	}
}

func TestPreviewElidedPathMissingVsAmbiguous(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "repo")
	mainHandler := filepath.Join(work, "internal", "handler.go")
	wtHandler := filepath.Join(work, "tmp", "wt", "wt1", "internal", "handler.go")
	if err := os.MkdirAll(filepath.Dir(mainHandler), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(wtHandler), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mainHandler, []byte("package internal\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wtHandler, []byte("package internal_wt\n"), 0644); err != nil {
		t.Fatal(err)
	}
	wtGit := filepath.Join(work, "tmp", "wt", "wt1", ".git")
	if err := os.WriteFile(wtGit, []byte("gitdir: /tmp/repo/.git/worktrees/wt1\n"), 0644); err != nil {
		t.Fatal(err)
	}

	s := New()
	// 1. 0 匹配的省略路径应返回 missing，而不是 ambiguous
	if r := s.Open(work, ".../does-not-exist.md", home, false); r.Code != "missing" {
		t.Fatalf("expected missing for absent elided path, got %+v", r)
	}
	// 2. 跳过嵌套 git worktree 副本后，主仓唯一文件能唯一命中
	if r := s.Open(work, ".../internal/handler.go", home, false); !r.OK || r.Content != "package internal\n" {
		t.Fatalf("expected unique main repo file skipping worktree, got %+v", r)
	}
}
