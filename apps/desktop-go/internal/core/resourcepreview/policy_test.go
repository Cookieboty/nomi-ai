package resourcepreview

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProtectedPathsRevokeExistingPreviewCapabilities(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(root, "private")
	if err := os.Mkdir(secret, 0700); err != nil {
		t.Fatal(err)
	}
	document := filepath.Join(secret, "note.md")
	html := filepath.Join(root, "page.html")
	for path, text := range map[string]string{document: "private text", html: "<h1>page</h1>"} {
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	protected := []string{}
	s := New()
	defer s.Shutdown()
	s.ProtectedPaths = func() []string { return protected }
	doc := s.Open(root, document, "/nonexistent-home", false)
	page := s.Open(root, html, "/nonexistent-home", false)
	if !doc.Editable || !page.OK {
		t.Fatalf("initial grant: %+v %+v", doc, page)
	}
	// The setting changes while a file, its writer and an HTML browser page are open.
	protected = []string{secret}
	t.Run("open", func(t *testing.T) {
		if r := s.Open(root, document, "/nonexistent-home", true); r.Code != "denied" {
			t.Fatalf("protected file opened despite explicit outside consent: %+v", r)
		}
	})
	t.Run("save", func(t *testing.T) {
		if r := s.Save(doc.URL, doc.Revision, "overwrite"); r.Code != "denied" {
			t.Fatalf("protected writer remained usable: %+v", r)
		}
		if b, _ := os.ReadFile(document); string(b) != "private text" {
			t.Fatal("protected content overwritten")
		}
	})
	t.Run("stream", func(t *testing.T) {
		w := httptest.NewRecorder()
		s.Middleware(http.NotFoundHandler()).ServeHTTP(w, httptest.NewRequest("GET", doc.URL, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("protected content still streamed: %d", w.Code)
		}
	})
	t.Run("directory", func(t *testing.T) {
		if r := s.ListDirectory(doc.URL, secret); r.Code != "denied" {
			t.Fatalf("protected directory listed: %+v", r)
		}
		r := s.ListDirectory(page.URL, root)
		for _, entry := range r.Entries {
			if entry.Name == "private" {
				t.Fatal("protected subdirectory exposed by listing")
			}
		}
	})
	t.Run("browser-assets", func(t *testing.T) {
		response, err := http.Get(page.BrowserURL[:strings.LastIndex(page.BrowserURL, "/")+1] + "private/note.md")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("protected asset still served to HTML: %d", response.StatusCode)
		}
	})
}
