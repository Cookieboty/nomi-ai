package resourcepreview

import (
	"net/url"
	"path/filepath"
	"strings"
	"unicode"
)

// External opens websites/HTML in the browser and an allowlist of document/media
// formats in their default applications. All local files keep workspace consent,
// protected-directory, symlink and file-identity checks before reaching the shell.
func (s *Service) External(cwd, raw, home string, allowOutside bool) Result {
	if len(raw) == 0 || len(raw) > 8192 || strings.IndexFunc(raw, unicode.IsControl) >= 0 {
		return fail("invalid")
	}
	u, err := url.Parse(raw)
	if err == nil && (strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) {
		if u.Hostname() == "" || u.User != nil || strings.Contains(u.Host, "\\") {
			return fail("invalid")
		}
		if s.OpenExternal == nil {
			return fail("unavailable")
		}
		if err := s.OpenExternal(u.String()); err != nil {
			return fail("browser")
		}
		return Result{OK: true, Kind: "external", Path: raw}
	}
	if err == nil && u.Scheme != "" && !strings.EqualFold(u.Scheme, "file") && !(len(u.Scheme) == 1 && len(raw) > 2 && raw[1] == ':') {
		return fail("invalid")
	}
	if err == nil && strings.EqualFold(u.Scheme, "file") {
		if u.Host != "" && u.Host != "localhost" {
			return fail("invalid")
		}
		raw = u.Path
		if platform() == "win32" && len(raw) > 3 && raw[0] == '/' && raw[2] == ':' {
			raw = raw[1:]
		}
		raw = filepath.FromSlash(raw)
	}
	if kindOf(raw) != "html" && !nativeFileKind(kindOf(raw)) {
		return fail("invalid")
	}
	// Open checks symlinks, protected directories, file identity and explicit outside-file consent.
	result := s.Open(cwd, raw, home, allowOutside)
	if !result.OK {
		return result
	}
	if result.Kind == "external" && nativeFileKind(kindOf(result.Path)) {
		if s.OpenFile == nil {
			return fail("unavailable")
		}
		if err := s.OpenFile(result.Path); err != nil {
			return fail("browser")
		}
		return Result{OK: true, Kind: "external", Path: result.Path}
	}
	if result.Kind != "html" {
		s.Close(result.URL)
		return fail("invalid")
	}
	if s.OpenExternal == nil {
		s.Close(result.URL)
		return fail("unavailable")
	}
	if err := s.OpenExternal(result.BrowserURL); err != nil {
		s.Close(result.URL)
		return fail("browser")
	}
	// The native browser owns the visible page. Do not revoke its assets when the chat view changes.
	// Capabilities remain TTL-limited and are removed on app shutdown.
	return Result{OK: true, Kind: "external", Path: result.Path}
}

func nativeFileKind(kind string) bool {
	switch kind {
	case "office", "pdf", "video", "audio":
		return true
	default:
		return false
	}
}
