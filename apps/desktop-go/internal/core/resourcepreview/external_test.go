package resourcepreview

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExternalWebUsesNativeBrowserWithoutFetchingOrEmbedding(t *testing.T) {
	s := New()
	defer s.Shutdown()
	var opened string
	s.OpenExternal = func(raw string) error { opened = raw; return nil }
	for _, raw := range []string{"https://www.baidu.com/", "http://127.0.0.1:9/", "http://site.invalid/path?q=foo#section"} {
		result := s.External("", raw, "", false)
		if !result.OK || result.Kind != "external" || opened != raw {
			t.Fatalf("external navigation: %+v %s", result, opened)
		}
	}
	if s.browser != nil || len(s.items) != 0 {
		t.Fatal("website started internal browser/media server")
	}
}
func TestExternalRejectsCommandsProtocolsAndCredentials(t *testing.T) {
	s := New()
	calls := 0
	s.OpenExternal = func(raw string) error { calls++; return nil }
	for _, raw := range []string{"javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://example.com", "https://user:pass@example.com/", "https:///missing-host", "https://example.com/\n--arg", "", "mailto:a@example.com"} {
		if result := s.External("", raw, "", false); result.OK {
			t.Fatalf("accepted unsafe external URL %q", raw)
		}
	}
	if calls != 0 {
		t.Fatal("unsafe target reached shell")
	}
}
func TestExternalHTMLChecksPermissionAndKeepsAssetsAlive(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "page.html")
	_ = os.WriteFile(file, []byte(`<h1>page</h1><script src="app.js"></script>`), 0600)
	_ = os.WriteFile(filepath.Join(dir, "app.js"), []byte("document.body.dataset.loaded='yes'"), 0600)
	s := New()
	defer s.Shutdown()
	var opened string
	s.OpenExternal = func(raw string) error { opened = raw; return nil }
	result := s.External(dir, "page.html", "/nonexistent-home", false)
	if !result.OK || result.Kind != "external" || !strings.HasPrefix(opened, "http://127.0.0.1:") {
		t.Fatalf("HTML not externally opened: %+v %s", result, opened)
	}
	response, err := http.Get(opened)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("external HTML prematurely revoked")
	}
	assets := opened[:strings.LastIndex(opened, "/")+1] + "app.js"
	response, err = http.Get(assets)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("adjacent assets missing")
	}
	// Metadata from a prior page remains capability-bound and expires rather than leaking files.
	s.mu.Lock()
	for token, value := range s.items {
		value.at = time.Now().Add(-2 * ttl)
		s.items[token] = value
	}
	s.mu.Unlock()
	response, err = http.Get(opened)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("expired HTML still served")
	}
	outside := t.TempDir()
	outFile := filepath.Join(outside, "outside.html")
	_ = os.WriteFile(outFile, []byte("outside"), 0600)
	opened = ""
	result = s.External(dir, outFile, "/nonexistent-home", false)
	if result.Code != "authorization" || opened != "" {
		t.Fatalf("outside HTML lacked consent: %+v", result)
	}
	result = s.External(dir, outFile, "/nonexistent-home", true)
	if !result.OK {
		t.Fatalf("explicit HTML permission failed: %+v", result)
	}
}
func TestExternalFailuresAndNonHTMLNeverExecuteFiles(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	_ = os.WriteFile(file, []byte("text"), 0600)
	s := New()
	defer s.Shutdown()
	calls := 0
	s.OpenExternal = func(string) error { calls++; return errors.New("browser unavailable") }
	if r := s.External(dir, file, "", false); r.OK || calls != 0 {
		t.Fatal("non-HTML file opened externally")
	}
	_ = os.WriteFile(filepath.Join(dir, "page.html"), []byte("html"), 0600)
	if r := s.External(dir, "page.html", "", false); r.Code != "browser" {
		t.Fatalf("missing browser error: %+v", r)
	}
	if len(s.items) != 0 {
		t.Fatal("failed HTML open leaked capability")
	}
	if r := New().External("", "https://example.com/", "", false); r.Code != "unavailable" {
		t.Fatalf("missing shell error: %+v", r)
	}
}

func TestExternalDocumentsAndMediaUseDefaultAppsWithoutPreview(t *testing.T) {
	dir := t.TempDir()
	s := New()
	defer s.Shutdown()
	var opened string
	s.OpenFile = func(path string) error { opened = path; return nil }
	s.OpenExternal = func(string) error { t.Fatal("native file sent to browser"); return nil }
	for _, ext := range []string{"docx", "xlsx", "csv", "CSV", "pptx", "pdf", "mp4", "webm", "mov", "m4v", "ogv", "mp3", "wav", "m4a", "ogg", "flac", "aac"} {
		t.Run(ext, func(t *testing.T) {
			file := filepath.Join(dir, "test."+ext)
			// Content deliberately isn't OOXML/media: opening must not parse/convert the file.
			if err := os.WriteFile(file, []byte("native content"), 0600); err != nil {
				t.Fatal(err)
			}
			opened = ""
			r := s.Open(dir, file, "/nonexistent-home", false)
			if !r.OK || r.Kind != "external" || r.URL != "" {
				t.Fatalf("embedded capability created: %+v", r)
			}
			r = s.External(dir, file, "/nonexistent-home", false)
			real, _ := filepath.EvalSymlinks(file)
			if !r.OK || r.Kind != "external" || opened != real {
				t.Fatalf("default app not opened: %+v %s", r, opened)
			}
			if len(s.items) != 0 || s.browser != nil {
				t.Fatal("native file created embedded preview service")
			}
		})
	}
	outside := filepath.Join(t.TempDir(), "outside.pdf")
	os.WriteFile(outside, []byte("pdf"), 0600)
	opened = ""
	if r := s.External(dir, outside, "/nonexistent-home", false); r.Code != "authorization" || opened != "" {
		t.Fatalf("outside file bypassed consent: %+v", r)
	}
	if r := s.External(dir, outside, "/nonexistent-home", true); !r.OK {
		t.Fatalf("approved file not opened: %+v", r)
	}
	link := filepath.Join(dir, "outside.pdf")
	os.Symlink(outside, link)
	opened = ""
	if r := s.External(dir, link, "/nonexistent-home", false); r.Code != "authorization" || opened != "" {
		t.Fatal("symlink bypassed consent")
	}
	denied := filepath.Join(dir, ".ssh", "private.pdf")
	os.MkdirAll(filepath.Dir(denied), 0700)
	os.WriteFile(denied, []byte("secret"), 0600)
	if r := s.External(dir, denied, "/nonexistent-home", true); r.Code != "denied" {
		t.Fatalf("protected file opened: %+v", r)
	}
}

func TestExternalNativeFileFailuresAndExecutableSymlinks(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "book.docx")
	os.WriteFile(file, []byte("doc"), 0600)
	s := New()
	defer s.Shutdown()
	if r := s.External(dir, file, "/nonexistent-home", false); r.Code != "unavailable" {
		t.Fatalf("missing native shell: %+v", r)
	}
	calls := 0
	s.OpenFile = func(string) error { calls++; return errors.New("no associated app") }
	if r := s.External(dir, file, "/nonexistent-home", false); r.Code != "browser" || calls != 1 {
		t.Fatalf("shell failure: %+v", r)
	}
	binary := filepath.Join(dir, "program.exe")
	os.WriteFile(binary, []byte("binary"), 0600)
	link := filepath.Join(dir, "safe.pdf")
	os.Symlink(binary, link)
	if r := s.External(dir, link, "/nonexistent-home", false); r.OK || calls != 1 {
		t.Fatal("executable reached native shell")
	}
}

func TestCSVFileURIAndResolvedAliasStayExternal(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "annual report.CSV")
	os.WriteFile(file, []byte("name,value\nrow,1\n"), 0600)
	real, _ := filepath.EvalSymlinks(file)
	s := New()
	defer s.Shutdown()
	var opened string
	s.OpenFile = func(path string) error { opened = path; return nil }
	// 文件 URI 的路径以 / 开头：Windows 上是 file:///C:/…（不加 / 时 C: 会被当成主机名）
	slashed := filepath.ToSlash(file)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	uri := (&url.URL{Scheme: "file", Path: slashed}).String()
	if r := s.External(dir, uri, "/nonexistent-home", false); !r.OK || opened != real {
		t.Fatalf("CSV file URI not handled: %+v %q", r, opened)
	}
	alias := filepath.Join(dir, "note.txt")
	if err := os.Symlink(file, alias); err != nil {
		t.Fatal(err)
	}
	r := s.Open(dir, alias, "/nonexistent-home", false)
	if !r.OK || r.Kind != "external" || r.Path != real || r.Content != "" || r.URL != "" || r.Editable {
		t.Fatalf("CSV alias became text or writable preview: %+v", r)
	}
	if len(s.items) != 0 {
		t.Fatal("CSV preview capability created")
	}
}
