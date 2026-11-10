package resourcepreview

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestPreviewSaveAtomicRevisionAndPermissions(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "readme.md")
	original := "# title\r\n\r\n```mermaid\r\nA --> B\r\n```\r\n"
	_ = os.WriteFile(path, []byte(original), 0640)
	s := New()
	r := s.Open(root, path, "/nonexistent-home", false)
	if !r.Editable || r.Revision != revisionOf(original) {
		t.Fatalf("open %+v", r)
	}
	text := strings.Replace(original, "title", "edited", 1)
	saved := s.Save(r.URL, r.Revision, text)
	if !saved.OK || saved.Revision != revisionOf(text) {
		t.Fatalf("save %+v", saved)
	}
	b, _ := os.ReadFile(path)
	st, _ := os.Stat(path)
	if string(b) != text {
		t.Fatal("content lost")
	}
	// Windows 没有 Unix 权限位（只有只读与否），只在 Unix 上比较
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0640 {
		t.Fatalf("permissions lost: %v", st.Mode().Perm())
	}
	if r := s.Save(r.URL, r.Revision, "stale"); r.Code != "conflict" {
		t.Fatalf("stale %+v", r)
	}
	if r := s.Save(r.URL, saved.Revision, text+"next"); !r.OK {
		t.Fatalf("next %+v", r)
	}
}
func TestPreviewSaveRejectsExternalChangesAndReadOnlyCapabilities(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "doc.md")
	_ = os.WriteFile(path, []byte("old"), 0600)
	s := New()
	r := s.Open(root, path, "/nonexistent-home", false)
	_ = os.WriteFile(path, []byte("external"), 0600)
	if v := s.Save(r.URL, r.Revision, "overwrite"); v.Code != "conflict" {
		t.Fatalf("external %+v", v)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "external" {
		t.Fatal("clobbered external write")
	}
	outside := s.Open(filepath.Join(root, "unregistered"), path, "/nonexistent-home", true)
	if outside.Editable {
		t.Fatal("read consent allowed writes")
	}
	if v := s.Save(outside.URL, revisionOf("external"), "x"); v.Code != "readonly" {
		t.Fatalf("readonly %+v", v)
	}
	s.Close(r.URL)
	if v := s.Save(r.URL, r.Revision, "x"); v.Code != "expired" {
		t.Fatalf("closed %+v", v)
	}
}
func TestPreviewSaveRejectsReplacementSymlinkAndBinary(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "doc.md")
	_ = os.WriteFile(path, []byte("old"), 0600)
	s := New()
	r := s.Open(root, path, "/nonexistent-home", false)
	other := filepath.Join(t.TempDir(), "other.md")
	_ = os.WriteFile(other, []byte("old"), 0600)
	_ = os.Remove(path)
	if err := os.Symlink(other, path); err != nil {
		t.Skip(err)
	}
	if v := s.Save(r.URL, r.Revision, "bad"); v.Code != "denied" {
		t.Fatalf("symlink %+v", v)
	}
	for _, text := range []string{"bad\x00", strings.Repeat("x", textLimit+1)} {
		if v := s.Save(r.URL, r.Revision, text); v.Code != "invalid" {
			t.Fatalf("invalid %+v", v)
		}
	}
	_ = os.Remove(path)
	_ = os.WriteFile(path, []byte(strings.Repeat("x", textLimit+1)), 0600)
	large := s.Open(root, path, "/nonexistent-home", false)
	if large.Editable {
		t.Fatal("truncated preview writable")
	}
}
func TestConcurrentPreviewSavesOnlyOneExpectedRevisionWins(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "doc.md")
	_ = os.WriteFile(path, []byte("old"), 0600)
	s := New()
	r := s.Open(root, path, "/nonexistent-home", false)
	var wg sync.WaitGroup
	results := make(chan SaveResult, 2)
	for _, text := range []string{"a", "b"} {
		wg.Add(1)
		go func(text string) { defer wg.Done(); results <- s.Save(r.URL, r.Revision, text) }(text)
	}
	wg.Wait()
	close(results)
	wins := 0
	for res := range results {
		if res.OK {
			wins++
		} else if res.Code != "conflict" {
			t.Fatalf("save %+v", res)
		}
	}
	if wins != 1 {
		t.Fatalf("wins %d", wins)
	}
}

func TestPreviewReadOnlyFileIsNotEditable(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "readonly.md")
	_ = os.WriteFile(path, []byte("readonly"), 0400)
	s := New()
	r := s.Open(root, path, "/nonexistent-home", false)
	if r.Editable {
		t.Fatal("read-only file marked editable")
	}
	if saved := s.Save(r.URL, revisionOf("readonly"), "changed"); saved.Code != "readonly" {
		t.Fatalf("read-only %+v", saved)
	}
}
