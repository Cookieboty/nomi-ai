package resourcepreview

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceEditGrantPreservesPreviewDefaults(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"page.html", "icon.svg", "source.custom"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(root, name)
			if err := os.WriteFile(path, []byte("<source/>"), 0600); err != nil {
				t.Fatal(err)
			}
			s := New()
			normal := s.Open(root, path, "/nonexistent-home", false)
			if normal.Editable != (name == "source.custom") {
				t.Fatalf("default preview changed: %+v", normal)
			}
			opened := s.Open(root, path, "/nonexistent-home", false, true)
			if !opened.Editable || opened.Kind != "text" || opened.Content != "<source/>" {
				t.Fatalf("source open: %+v", opened)
			}
			if saved := s.Save(opened.URL, opened.Revision, "<edited/>"); !saved.OK {
				t.Fatalf("source save: %+v", saved)
			}
			stale := s.Open(root, path, "/nonexistent-home", false, true)
			_ = os.WriteFile(path, []byte("external"), 0600)
			if saved := s.Save(stale.URL, stale.Revision, "overwrite"); saved.Code != "conflict" {
				t.Fatalf("stale save: %+v", saved)
			}
		})
	}
}
func TestSourceEditGrantKeepsTextAndPermissionBoundaries(t *testing.T) {
	root := t.TempDir()
	s := New()
	for _, content := range []string{"binary\x00data", string([]byte{0xff, 0xfe}), strings.Repeat("x", textLimit+1)} {
		path := filepath.Join(root, "file.svg")
		_ = os.WriteFile(path, []byte(content), 0600)
		if r := s.Open(root, path, "/nonexistent-home", false, true); r.Editable {
			t.Fatalf("noneditable content got grant: %+v", r)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.html")
	_ = os.WriteFile(outside, []byte("text"), 0600)
	if r := s.Open(root, outside, "/nonexistent-home", false, true); r.OK {
		t.Fatalf("outside allowed: %+v", r)
	}
	if r := s.Open(root, outside, "/nonexistent-home", true, true); r.Editable {
		t.Fatalf("read consent became write consent: %+v", r)
	}
}
