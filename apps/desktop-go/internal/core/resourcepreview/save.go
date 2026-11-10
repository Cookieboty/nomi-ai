package resourcepreview

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

type SaveResult struct {
	OK       bool   `json:"ok"`
	Code     string `json:"code,omitempty"`
	Revision string `json:"revision,omitempty"`
}

func saveFail(code string) SaveResult { return SaveResult{Code: code} }
func revisionOf(text string) string   { return fmt.Sprintf("%x", sha256.Sum256([]byte(text))) }

// Save only accepts the capability issued when opening an editable file. The caller cannot
// supply a replacement path or extend read consent outside a validated workspace into writes.
func (s *Service) Save(url, revision, content string) SaveResult {
	if !strings.HasPrefix(url, Prefix) || len(content) > textLimit || !utf8.ValidString(content) || strings.ContainsRune(content, 0) {
		return saveFail("invalid")
	}
	token := strings.TrimPrefix(url, Prefix)
	// Only the capability table is locked; file IO (reads, fsync, rename) runs outside so
	// autosave does not stall preview requests. Concurrent saves are settled by the
	// on-disk revision check right before the rename.
	s.mu.Lock()
	cap, ok := s.items[token]
	s.mu.Unlock()
	if !ok || time.Since(cap.at) > ttl {
		return saveFail("expired")
	}
	if cap.editRoot == "" || cap.revision == "" {
		return saveFail("readonly")
	}
	if revision != cap.revision {
		return saveFail("conflict")
	}
	root := desktop.CheckWorkspaceRoot(cap.editRoot, desktop.WorkspaceEnv{Home: cap.home, Platform: platform(), DenyRoots: s.DenyRoots})
	real, err := filepath.EvalSymlinks(cap.path)
	if !root.OK || err != nil || real != cap.path || !desktop.IsInside(real, root.Real, platform()) || s.denyReason(real) != "" {
		return saveFail("denied")
	}
	info, err := os.Stat(real)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, cap.info) || info.Size() > textLimit {
		return saveFail("conflict")
	}
	if info.Mode().Perm()&0222 == 0 {
		return saveFail("readonly")
	}
	before, err := os.ReadFile(real)
	if err != nil {
		return saveFail("write")
	}
	if revisionOf(string(before)) != revision {
		return saveFail("conflict")
	}
	temp, err := os.CreateTemp(filepath.Dir(real), ".nomi-preview-save-*")
	if err != nil {
		return saveFail("write")
	}
	tmp := temp.Name()
	defer os.Remove(tmp)
	if err = temp.Chmod(info.Mode().Perm()); err == nil {
		_, err = temp.WriteString(content)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil || closeErr != nil {
		return saveFail("write")
	}
	// External replacement, symlink changes, or edits while preparing the atomic write must
	// not be silently overwritten. Nothing touches the original until the final validation.
	currentReal, e := filepath.EvalSymlinks(cap.path)
	now, statErr := os.Stat(real)
	current, readErr := os.ReadFile(real)
	if e != nil || currentReal != real || statErr != nil || !os.SameFile(info, now) || readErr != nil || revisionOf(string(current)) != revision || !now.ModTime().Equal(info.ModTime()) {
		return saveFail("conflict")
	}
	if err = os.Rename(tmp, real); err != nil {
		return saveFail("write")
	}
	updated, err := os.Stat(real)
	if err != nil {
		return saveFail("write")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := revisionOf(content)
	// The file is written; record it unless the preview was closed meanwhile.
	if latest, ok := s.items[token]; ok {
		latest.info, latest.revision, latest.at = updated, next, time.Now()
		s.items[token] = latest
	}
	return SaveResult{OK: true, Revision: next}
}
