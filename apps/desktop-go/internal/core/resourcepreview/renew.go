package resourcepreview

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

// Renew re-checks an edit capability and, when the file is still the same bytes,
// issues a new one. An expired grant is not extended in place. The caller must
// save with the returned URL; this does not write the draft.
//
// A missing grant (closed, or swept when another file was opened) is "expired".
// A different inode, symlink, or external edit is refused and no writable URL is
// returned, so the caller cannot overwrite that change with the new revision.
func (s *Service) Renew(url string) Result {
	if !strings.HasPrefix(url, Prefix) {
		return fail("expired")
	}
	token := strings.TrimPrefix(url, Prefix)
	s.mu.Lock()
	cap, ok := s.items[token]
	s.mu.Unlock()
	if !ok {
		return fail("expired")
	}
	if cap.editRoot == "" || cap.revision == "" || cap.info == nil || cap.path == "" {
		return fail("readonly")
	}
	root := desktop.CheckWorkspaceRoot(cap.editRoot, desktop.WorkspaceEnv{Home: cap.home, Platform: platform(), DenyRoots: s.DenyRoots})
	real, err := filepath.EvalSymlinks(cap.path)
	if err != nil || !root.OK || real != cap.path || !desktop.IsInside(real, root.Real, platform()) || s.denyReason(real) != "" {
		if err != nil && os.IsNotExist(err) {
			return fail("missing")
		}
		return fail("denied")
	}
	info, err := os.Stat(real)
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, cap.info) || info.Size() > textLimit {
		return fail("conflict")
	}
	if info.Mode().Perm()&0222 == 0 {
		return fail("readonly")
	}
	before, err := os.ReadFile(real)
	if err != nil {
		return fail("read")
	}
	if strings.ContainsRune(string(before), 0) || !utf8.Valid(before) {
		return fail("encoding")
	}
	if revisionOf(string(before)) != cap.revision {
		return fail("conflict")
	}
	// Copy the edit binding before grant: issuing a token sweeps expired grants,
	// including this one, and must not lose the workspace it was bound to.
	editRoot, home, revision := cap.editRoot, cap.home, cap.revision
	fresh, err := s.grant(real, info)
	if err != nil {
		return fail("read")
	}
	s.mu.Lock()
	next := s.items[fresh]
	next.editRoot, next.home, next.revision = editRoot, home, revision
	s.items[fresh] = next
	s.mu.Unlock()
	kind := kindOf(real)
	return Result{
		OK: true, Path: real, Kind: kind, URL: Prefix + fresh,
		Content: string(before), Editable: true, Revision: revision,
	}
}
