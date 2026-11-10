package resourcepreview

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

const directoryLimit = 4000

type DirectoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type DirectoryResult struct {
	OK        bool             `json:"ok"`
	Code      string           `json:"code,omitempty"`
	Entries   []DirectoryEntry `json:"entries,omitempty"`
	Truncated bool             `json:"truncated,omitempty"`
}

// ListDirectory exposes names, never file contents or write permissions. A live file
// capability allows its ancestor directories; further folders must have appeared in a
// previous listing. Browsing does not grant Open/Save access to any returned file.
func (s *Service) ListDirectory(url, input string) DirectoryResult {
	fail := func(code string) DirectoryResult { return DirectoryResult{Code: code} }
	if !strings.HasPrefix(url, Prefix) || !filepath.IsAbs(input) || strings.ContainsRune(input, 0) {
		return fail("invalid")
	}
	token := strings.TrimPrefix(url, Prefix)
	s.mu.Lock()
	cap, ok := s.items[token]
	s.mu.Unlock()
	if !ok || time.Since(cap.at) > ttl {
		return fail("expired")
	}
	path, err := filepath.EvalSymlinks(filepath.Clean(input))
	if err != nil {
		return fail("missing")
	}
	if s.denyReason(input) != "" || s.denyReason(path) != "" {
		return fail("denied")
	}
	s.mu.Lock()
	_, listed := cap.browseDirs[path]
	s.mu.Unlock()
	if !listed && !desktop.IsInside(cap.path, path, platform()) {
		return fail("denied")
	}
	file, err := os.Open(path)
	if err != nil {
		return fail("read")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.IsDir() {
		return fail("invalid")
	}
	items, err := file.ReadDir(directoryLimit + 1)
	if err != nil && err != io.EOF {
		return fail("read")
	}
	result := DirectoryResult{OK: true, Entries: []DirectoryEntry{}, Truncated: len(items) > directoryLimit}
	if result.Truncated {
		items = items[:directoryLimit]
	}
	directories := []string{}
	for _, entry := range items {
		candidate := filepath.Join(path, entry.Name())
		if s.denyReason(candidate) != "" {
			continue
		}
		real, err := filepath.EvalSymlinks(candidate)
		if err != nil || s.denyReason(real) != "" {
			continue
		}
		child, err := os.Stat(real)
		if err != nil || !child.IsDir() && !child.Mode().IsRegular() {
			continue
		}
		kind := "file"
		if child.IsDir() {
			kind = "dir"
			directories = append(directories, real)
		}
		result.Entries = append(result.Entries, DirectoryEntry{Name: entry.Name(), Path: real, Kind: kind})
	}
	now, err := os.Stat(path)
	if err != nil || !os.SameFile(info, now) {
		return fail("changed")
	}
	sort.SliceStable(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Kind != b.Kind {
			return a.Kind == "dir"
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	cap, ok = s.items[token]
	if !ok || time.Since(cap.at) > ttl {
		return fail("expired")
	}
	if cap.browseDirs == nil {
		cap.browseDirs = make(map[string]struct{})
	}
	for _, directory := range directories {
		cap.browseDirs[directory] = struct{}{}
	}
	s.items[token] = cap
	return result
}
