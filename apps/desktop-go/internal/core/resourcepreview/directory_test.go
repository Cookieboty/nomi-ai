package resourcepreview

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreviewDirectoryAncestorsAndExplicitTraversal(t *testing.T) {
	dir := t.TempDir()
	work := filepath.Join(dir, "project")
	docs := filepath.Join(work, "docs")
	other := filepath.Join(dir, "other")
	for _, p := range []string{docs, other} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(docs, "note.md")
	if err := os.WriteFile(file, []byte("# Document"), 0600); err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(other, "outside.txt")
	if err := os.WriteFile(sibling, []byte("private body"), 0600); err != nil {
		t.Fatal(err)
	}
	s := New()
	opened := s.Open(work, file, "/nonexistent-home", false)
	if !opened.OK {
		t.Fatal(opened)
	}
	if r := s.ListDirectory(opened.URL, other); r.Code != "denied" {
		t.Fatalf("unlisted directory: %+v", r)
	}
	parent := s.ListDirectory(opened.URL, dir)
	if !parent.OK || len(parent.Entries) != 2 || parent.Entries[0].Kind != "dir" {
		t.Fatalf("parent listing: %+v", parent)
	}
	listed := s.ListDirectory(opened.URL, other)
	if !listed.OK || len(listed.Entries) != 1 || listed.Entries[0].Name != "outside.txt" {
		t.Fatalf("explicit folder traversal: %+v", listed)
	}
	if r := s.Open(work, sibling, "/nonexistent-home", false); r.Code != "authorization" {
		t.Fatalf("browsing granted content access: %+v", r)
	}
	if r := s.Save(opened.URL, opened.Revision, "# Changed"); !r.OK {
		t.Fatalf("directory listing disturbed original write capability: %+v", r)
	}
	s.Close(opened.URL)
	if r := s.ListDirectory(opened.URL, dir); r.Code != "expired" {
		t.Fatalf("closed: %+v", r)
	}
}

func TestPreviewDirectoryProtectsNamesAndSymlinkTargets(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, ".ssh")
	deny := filepath.Join(dir, "blocked")
	for _, p := range []string{secret, deny} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(dir, "note.md")
	_ = os.WriteFile(file, []byte("# Notes"), 0600)
	_ = os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=value"), 0600)
	_ = os.Symlink(secret, filepath.Join(dir, "alias"))
	s := New(deny)
	opened := s.Open(dir, file, "/nonexistent-home", false)
	if !opened.OK {
		t.Fatal(opened)
	}
	result := s.ListDirectory(opened.URL, dir)
	if !result.OK || len(result.Entries) != 1 || result.Entries[0].Name != "note.md" {
		t.Fatalf("sensitive entries: %+v", result)
	}
	if r := s.ListDirectory(opened.URL, filepath.Join(dir, "alias")); r.Code != "denied" {
		t.Fatal(r)
	}
	token := strings.TrimPrefix(opened.URL, Prefix)
	s.mu.Lock()
	cap := s.items[token]
	cap.at = time.Now().Add(-2 * ttl)
	s.items[token] = cap
	s.mu.Unlock()
	if r := s.ListDirectory(opened.URL, dir); r.Code != "expired" {
		t.Fatal(r)
	}
}

func TestPreviewDirectoryOutsideFileHasNamesOnlyAndHandlesEmptyDirectories(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty")
	_ = os.Mkdir(empty, 0700)
	file := filepath.Join(dir, "note.md")
	_ = os.WriteFile(file, []byte("# Outside"), 0600)
	s := New()
	opened := s.Open("", file, "/nonexistent-home", true)
	if !opened.OK || opened.Editable {
		t.Fatal(opened)
	}
	if r := s.ListDirectory(opened.URL, dir); !r.OK {
		t.Fatal(r)
	}
	if r := s.ListDirectory(opened.URL, empty); !r.OK || len(r.Entries) != 0 {
		t.Fatal(r)
	}
	if r := s.ListDirectory(opened.URL, "relative"); r.Code != "invalid" {
		t.Fatal(r)
	}
	if r := s.ListDirectory(Prefix+"missing", dir); r.Code != "expired" {
		t.Fatal(r)
	}
	if r := s.Save(opened.URL, strings.Repeat("0", 64), "new"); r.Code != "readonly" {
		t.Fatal(r)
	}
}

func TestPreviewDirectoryBoundsLargeListings(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < directoryLimit+2; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%04d.txt", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s := New()
	opened := s.Open(dir, filepath.Join(dir, "0000.txt"), "/nonexistent-home", false)
	result := s.ListDirectory(opened.URL, dir)
	if !result.OK || !result.Truncated || len(result.Entries) != directoryLimit {
		t.Fatal(result.OK, result.Truncated, len(result.Entries))
	}
}
