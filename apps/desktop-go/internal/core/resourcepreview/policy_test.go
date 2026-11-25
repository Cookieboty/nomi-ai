package resourcepreview

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreviewAllowsDotenvAndSensitiveDirectoryFiles(t *testing.T) {
	root := t.TempDir()
	sshDir := filepath.Join(root, ".ssh")
	if err := os.Mkdir(sshDir, 0700); err != nil {
		t.Fatal(err)
	}
	userData := t.TempDir()
	envFile := filepath.Join(root, ".env")
	html := filepath.Join(sshDir, "page.html")
	asset := filepath.Join(sshDir, "app.js")
	userDataFile := filepath.Join(userData, "note.md")
	for path, text := range map[string]string{
		envFile:      "SECRET=1\n",
		html:         `<h1>page</h1><script src="app.js"></script>`,
		asset:        `window.__loaded = true;`,
		userDataFile: "userdata",
	} {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}

	s := New(userData)
	defer s.Shutdown()
	now := withClock(s)

	doc := s.Open(root, envFile, "/nonexistent-home", false)
	if !doc.OK || !doc.Editable || doc.URL == "" {
		t.Fatalf("open .env: %+v", doc)
	}
	t.Run("stream", func(t *testing.T) {
		w := httptest.NewRecorder()
		s.Middleware(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest("GET", doc.URL, nil))
		if w.Code != http.StatusOK || w.Body.String() != "SECRET=1\n" {
			t.Fatalf("stream .env: %d %q", w.Code, w.Body.String())
		}
	})
	t.Run("directory", func(t *testing.T) {
		r := s.ListDirectory(doc.URL, root)
		if !r.OK {
			t.Fatalf("list root: %+v", r)
		}
		foundEnv := false
		for _, entry := range r.Entries {
			if entry.Name == ".env" {
				foundEnv = true
				break
			}
		}
		if !foundEnv {
			t.Fatalf(".env missing from listing: %+v", r.Entries)
		}
	})
	t.Run("save-and-renew", func(t *testing.T) {
		saved := s.Save(doc.URL, doc.Revision, "SECRET=2\n")
		if !saved.OK {
			t.Fatalf("save .env: %+v", saved)
		}
		if b, _ := os.ReadFile(envFile); string(b) != "SECRET=2\n" {
			t.Fatalf("disk .env: %q", b)
		}
		*now = now.Add(ttl + time.Second)
		renewed := s.Renew(doc.URL)
		if !renewed.OK || !renewed.Editable || renewed.URL == "" || renewed.URL == doc.URL {
			t.Fatalf("renew .env: %+v", renewed)
		}
	})
	t.Run("browser-assets", func(t *testing.T) {
		page := s.Open(root, html, "/nonexistent-home", false)
		if !page.OK || page.BrowserURL == "" {
			t.Fatalf("open .ssh/page.html: %+v", page)
		}
		resp, err := http.Get(page.BrowserURL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HTML status: %d", resp.StatusCode)
		}
		assetURL := page.BrowserURL[:strings.LastIndex(page.BrowserURL, "/")+1] + "app.js"
		assetResp, err := http.Get(assetURL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, assetResp.Body)
		assetResp.Body.Close()
		if assetResp.StatusCode != http.StatusOK {
			t.Fatalf("adjacent asset status: %d", assetResp.StatusCode)
		}
	})
	t.Run("deny-roots-stay-outside-writable-workspace", func(t *testing.T) {
		if r := s.Open(userData, userDataFile, "/nonexistent-home", false); r.Code != "authorization" {
			t.Fatalf("expected authorization for DenyRoots cwd: %+v", r)
		}
		r := s.Open(userData, userDataFile, "/nonexistent-home", true)
		if !r.OK || r.Editable || r.Content != "userdata" {
			t.Fatalf("expected readonly preview with consent: %+v", r)
		}
	})
}
