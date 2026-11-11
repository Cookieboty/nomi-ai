// Package resourcepreview serves short-lived, kernel-validated file capabilities to an isolated preview.
package resourcepreview

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
)

const Prefix = "/__nomi/preview/"
const textLimit = 1500000
const ttl = time.Hour

// Result contains text/image preview data or a validated path for an external application.
type Result struct {
	OK         bool   `json:"ok"`
	Code       string `json:"code,omitempty"`
	Path       string `json:"path,omitempty"`
	Kind       string `json:"kind,omitempty"`
	MIME       string `json:"mime,omitempty"`
	BrowserURL string `json:"-"`
	URL        string `json:"url,omitempty"`
	Content    string `json:"content,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	Editable   bool   `json:"editable,omitempty"`
	Revision   string `json:"revision,omitempty"`
}
type capability struct {
	browseDirs map[string]struct{}
	path       string
	info       os.FileInfo
	at         time.Time
	assetsRoot string
	editRoot   string
	home       string
	revision   string
}
type Service struct {
	ProtectedPaths func() []string
	// ProjectRoots：path 所在项目此刻可用的文件夹（realpath，已经过项目文件夹的校验）。
	// 项目的文件夹都是用户加过的工作区：链接跳到同项目的附加文件夹或别的项目文件夹时不再要求逐个文件授权，并且可以编辑
	ProjectRoots func(path string) []string
	OpenExternal func(string) error
	OpenFile     func(string) error
	mu           sync.Mutex
	items        map[string]capability
	// saveLocks：按文件串行化保存（路径 → *sync.Mutex）。只锁同一个文件的保存，预览请求与别的文件不受影响
	saveLocks     sync.Map
	DenyRoots     []string
	browser       *http.Server
	browserOrigin string
	// clock overrides time.Now for capability expiry. Tests set it; production leaves it nil.
	clock func() time.Time
}

func New(denyRoots ...string) *Service {
	return &Service{items: map[string]capability{}, DenyRoots: denyRoots}
}

func (s *Service) now() time.Time {
	if s.clock != nil {
		return s.clock()
	}
	return time.Now()
}

// projectRootOf：real 所在项目里包含它的最深的文件夹（重新按工作区规则校验）；不在任何项目里返回 ""
func (s *Service) projectRootOf(real, home string) string {
	if s.ProjectRoots == nil {
		return ""
	}
	best := ""
	for _, r := range s.ProjectRoots(real) {
		check := desktop.CheckWorkspaceRoot(r, desktop.WorkspaceEnv{Home: home, Platform: platform(), DenyRoots: s.DenyRoots})
		if check.OK && desktop.IsInside(real, check.Real, platform()) && len(check.Real) > len(best) {
			best = check.Real
		}
	}
	return best
}

func (s *Service) stale(at time.Time) bool { return s.now().Sub(at) > ttl }
func fail(code string) Result              { return Result{Code: code} }
func platform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// Open never grants a directory. Outside a known workspace, the UI must request explicit file consent.
func (s *Service) Open(cwd, input, home string, allowOutside bool) Result {
	p := strings.TrimSpace(input)
	if strings.ContainsRune(p, 0) || p == "" {
		return fail("invalid")
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		p = filepath.Join(home, p[2:])
	}
	if strings.HasPrefix(p, ".../") || strings.HasPrefix(p, "…/") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(p, ".../"), "…/")
		found, err := uniqueSuffix(cwd, suffix)
		if err != nil {
			return fail("ambiguous")
		}
		p = found
	}
	if !filepath.IsAbs(p) {
		if cwd == "" {
			return fail("workspace")
		}
		p = filepath.Join(cwd, p)
	}
	p, err := filepath.Abs(p)
	if err != nil {
		return fail("invalid")
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return fail("missing")
	}
	if s.denyReason(p) != "" || s.denyReason(real) != "" {
		return fail("denied")
	}
	inside := false
	editRoot := cwd
	if cwd != "" {
		check := desktop.CheckWorkspaceRoot(cwd, desktop.WorkspaceEnv{Home: home, Platform: platform(), DenyRoots: s.DenyRoots})
		inside = check.OK && desktop.IsInside(real, check.Real, platform())
	}
	if !inside {
		if r := s.projectRootOf(real, home); r != "" {
			inside, editRoot = true, r
		}
	}
	if !inside && !allowOutside {
		return Result{Code: "authorization", Path: real}
	}
	f, err := os.Open(real)
	if err != nil {
		return fail("read")
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return fail("unsupported")
	}
	// Reject a path replacement between resolution and opening.
	now, err := os.Stat(real)
	if err != nil || !os.SameFile(st, now) {
		return fail("changed")
	}
	kind := kindOf(real)
	result := Result{OK: true, Path: real, Kind: kind, MIME: mime.TypeByExtension(strings.ToLower(filepath.Ext(real)))}
	if result.MIME == "" {
		result.MIME = "application/octet-stream"
	}
	switch kind {
	case "office", "pdf", "video", "audio":
		// Native document/media viewers own these files. Do not decode them or
		// grant an embedded preview URL, including for links resolving via symlinks.
		return Result{OK: true, Kind: "external", Path: real}
	case "text", "markdown", "html":
		b, e := io.ReadAll(io.LimitReader(f, textLimit+1))
		if e != nil {
			return fail("read")
		}
		if strings.ContainsRune(string(b), 0) || !utf8.Valid(b) && len(b) <= textLimit {
			return fail("encoding")
		}
		if len(b) > textLimit {
			b = b[:textLimit]
			result.Truncated = true
		}
		result.Content = strings.ToValidUTF8(string(b), "�")
	case "unsupported":
		return fail("unsupported")
	}
	token, err := s.grant(real, st)
	if err != nil {
		return fail("read")
	}
	result.URL = Prefix + token
	if inside && st.Mode().Perm()&0222 != 0 && !result.Truncated && (kind == "markdown" || kind == "text") {
		result.Editable = true
		result.Revision = fmt.Sprintf("%x", sha256.Sum256([]byte(result.Content)))
		s.mu.Lock()
		cap := s.items[token]
		cap.editRoot, cap.home, cap.revision = editRoot, home, result.Revision
		s.items[token] = cap
		s.mu.Unlock()
	}
	if kind == "html" {
		// Adjacent assets are only available within an already approved workspace, not an outside-file grant.
		if inside {
			_ = s.setBrowserAssets(token, filepath.Dir(real))
		}
		result.BrowserURL, err = s.browserURL(token, filepath.Base(real))
		if err != nil {
			s.Close(result.URL)
			return fail("browser")
		}
	}
	return result
}

func kindOf(p string) string {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".md", ".markdown", ".mdx":
		return "markdown"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg", ".ico":
		return "image"
	case ".mp4", ".webm", ".mov", ".m4v", ".ogv":
		return "video"
	case ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac":
		return "audio"
	case ".pdf":
		return "pdf"
	case ".xlsx", ".csv", ".pptx", ".docx":
		return "office"
	case ".htm", ".html":
		return "html"
	case ".exe", ".dll", ".app", ".zip", ".gz", ".tar", ".7z", ".doc", ".xls", ".ppt", ".docm", ".xlsm", ".pptm":
		return "unsupported"
	default:
		return "text"
	}
}
func uniqueSuffix(root, suffix string) (string, error) {
	if root == "" || strings.Contains(suffix, "..") {
		return "", fmt.Errorf("invalid suffix")
	}
	var matches []string
	count := 0
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, e error) error {
		count++
		if count > 5000 {
			return fmt.Errorf("scan limit")
		}
		if e != nil {
			return nil
		}
		if d.IsDir() && p != root && strings.HasPrefix(d.Name(), ".") {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(filepath.ToSlash(p), "/"+filepath.ToSlash(suffix)) {
			matches = append(matches, p)
		}
		return nil
	})
	if err != nil || len(matches) != 1 {
		return "", fmt.Errorf("not unique")
	}
	return matches[0], nil
}
func (s *Service) grant(p string, st os.FileInfo) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.items {
		if s.stale(v.at) {
			delete(s.items, k)
		}
	}
	if len(s.items) >= 128 {
		var oldest string
		var at time.Time
		for k, v := range s.items {
			if oldest == "" || v.at.Before(at) {
				oldest = k
				at = v.at
			}
		}
		delete(s.items, oldest)
	}
	s.items[token] = capability{path: p, info: st, at: s.now()}
	return token, nil
}
func (s *Service) Close(raw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, strings.TrimPrefix(raw, Prefix))
}
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, Prefix) {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		token := strings.TrimPrefix(r.URL.Path, Prefix)
		s.mu.Lock()
		v, ok := s.items[token]
		if ok && s.stale(v.at) {
			delete(s.items, token)
			ok = false
		}
		s.mu.Unlock()
		if !ok || v.info != nil && s.denyReason(v.path) != "" {
			http.NotFound(w, r)
			return
		}
		if v.info == nil {
			serveRemote(w, r, v.path)
			return
		}
		f, err := os.Open(v.path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() || !os.SameFile(st, v.info) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// SVG/HTML are never permitted to execute code or fetch arbitrary local/network resources.
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'none'")
		typ := mime.TypeByExtension(filepath.Ext(v.path))
		if typ == "" {
			typ = "application/octet-stream"
		}
		w.Header().Set("Content-Type", typ)
		http.ServeContent(w, r, filepath.Base(v.path), st.ModTime(), f)
	})
}

// Wrap composes with the shell's constructor-style middleware chain.
func (s *Service) Wrap(next func(http.Handler) http.Handler) func(http.Handler) http.Handler {
	return func(root http.Handler) http.Handler { return s.Middleware(next(root)) }
}

// Read current protection settings on every access, including already-issued capabilities.
// Resolve policy aliases too, so a symlinked private-data root cannot bypass the guard.
func (s *Service) denyReason(path string) string {
	resolve := func(roots []string) []string {
		out := append([]string(nil), roots...)
		for _, root := range roots {
			if real, err := filepath.EvalSymlinks(root); err == nil {
				out = append(out, real)
			}
		}
		return out
	}
	var protected []string
	if s.ProtectedPaths != nil {
		protected = s.ProtectedPaths()
	}
	return desktop.DenyReasonWith(path, platform(), resolve(s.DenyRoots), resolve(protected))
}
