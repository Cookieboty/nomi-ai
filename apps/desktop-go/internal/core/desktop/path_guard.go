package desktop

import (
	"errors"
	"io/fs"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop/tr"
)

// pathGuard.ts：授权作用域 + 黑名单 + 规范化 + realpath 防符号链接逃逸

type GuardCode = string

// Scope 授权作用域（settings.json 里的形状）
type Scope struct {
	ID        string  `json:"id"`
	Path      string  `json:"path"`
	Mode      string  `json:"mode"`
	Kind      string  `json:"kind"`
	GrantedAt float64 `json:"grantedAt"`
	Session   bool    `json:"session,omitempty"`
}

// GuardResult：ok 时 Real/Scope/Exists 有效，否则 Code/Message
type GuardResult struct {
	OK      bool
	Real    string
	Scope   Scope
	Exists  bool
	Code    GuardCode
	Message string
}

func (g GuardResult) MarshalJSON() ([]byte, error) {
	if g.OK {
		return []byte(compactJSON(struct {
			OK     bool   `json:"ok"`
			Real   string `json:"real"`
			Scope  Scope  `json:"scope"`
			Exists bool   `json:"exists"`
		}{true, g.Real, g.Scope, g.Exists})), nil
	}
	return []byte(compactJSON(struct {
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}{false, g.Code, g.Message})), nil
}

// GuardEnv 对应 GuardEnv；Realpath 为空时用 RealpathNative
type GuardEnv struct {
	Scopes    []Scope
	Home      string
	Platform  string
	Realpath  func(string) (string, error)
	DenyRoots []string
}

// MaxPath 路径最大长度（UTF-16 码元）
const MaxPath = 4096

var denySegments = []string{".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "keychains", ".mozilla", "google-chrome", "chromium", "bravesoftware", ".gcloud", "gcloud"}

var denyFragments = []string{
	"/library/application support/google/chrome",
	"/library/application support/firefox",
	"/library/application support/microsoft edge",
	"/appdata/local/google/chrome",
	"/appdata/local/microsoft/edge",
	"/appdata/roaming/mozilla",
	"/appdata/local/microsoft/credentials",
	"/appdata/roaming/microsoft/credentials",
	"/appdata/roaming/microsoft/protect",
}

var denyNames = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$`),
	regexp.MustCompile(`(?i)\.kdbx?$`),
	regexp.MustCompile(`(?i)^\.env(\..*)?$`),
	regexp.MustCompile(`(?i)\.(pem|key|p12|pfx|keystore|jks)$`),
	regexp.MustCompile(`(?i)^\.netrc$`),
	regexp.MustCompile(`(?i)^\.npmrc$`),
	regexp.MustCompile(`(?i)^\.pypirc$`),
	regexp.MustCompile(`(?i)^\.git-credentials$`),
	regexp.MustCompile(`(?i)^login\.keychain(-db)?$`),
}

// ErrNotExist 供注入的 realpath 表示 ENOENT
var ErrNotExist = fs.ErrNotExist

// RealpathNative：fs.promises.realpath（D-B6-3：Windows 上为 EvalSymlinks + Abs）
func RealpathNative(p string) (string, error) {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	return filepath.Abs(r)
}

func caseInsensitive(platform string) bool { return platform == "win32" || platform == "darwin" }

var (
	reUNC       = regexp.MustCompile(`^[\\/]{2}`)
	reWinDrive  = regexp.MustCompile(`^[a-zA-Z]:[\\/]`)
	reDevice    = regexp.MustCompile(`^/(dev|proc|sys)(/|$)`)
	jsLowerRepl = strings.NewReplacer("\\", "/")
)

func badPath(msg string) GuardResult { return GuardResult{Code: "invalid_path", Message: msg} }

// NormalizeInput：语法检查 + ~ 展开 + 规范化；失败返回 (_, &GuardResult)
func NormalizeInput(input any, home, platform string) (string, *GuardResult) {
	fail := func(k string) (string, *GuardResult) { r := badPath(tr.T(k)); return "", &r }
	s, ok := input.(string)
	if !ok || jsTrim(s) == "" {
		return fail("electron.common.path-is-empty")
	}
	p := jsTrim(s)
	if u16len(p) > MaxPath {
		return fail("electron.common.path-too-long")
	}
	if strings.ContainsRune(p, 0) {
		return fail("electron.common.path-contains-invalid-characters")
	}
	if reUNC.MatchString(p) {
		return fail("electron.common.network-device-paths-unc-aren-t-supported")
	}
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		p = home + p[1:]
	}
	P := lib(platform)
	if !P.IsAbsolute(p) {
		return fail("electron.common.must-be-an-absolute-path-or-start-with")
	}
	if platform == "win32" && !reWinDrive.MatchString(p) {
		return fail("electron.common.windows-paths-must-include-a-drive-letter")
	}
	norm := P.Resolve(p)
	lower := strings.ToLower(jsLowerRepl.Replace(norm))
	if platform != "win32" && reDevice.MatchString(lower) {
		return fail("electron.common.device-paths-aren-t-supported")
	}
	return norm, nil
}

// jsTrim：String.prototype.trim（JS 空白集合）
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSSpace)
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// IsInside：child 是否在 parent 之内（含相等）
func IsInside(child, parent, platform string) bool {
	P := lib(platform)
	c, pa := P.Resolve(child), P.Resolve(parent)
	if caseInsensitive(platform) {
		c, pa = strings.ToLower(c), strings.ToLower(pa)
	}
	if c == pa {
		return true
	}
	rel := P.Relative(pa, c)
	return rel != "" && !strings.HasPrefix(rel, "..") && !P.IsAbsolute(rel)
}

// DenyReason：黑名单检查；命中返回原因
func DenyReason(p, platform string, denyRoots []string) string {
	for _, root := range denyRoots {
		if root != "" && IsInside(p, root, platform) {
			return tr.T("electron.common.app-private-data-folder")
		}
	}
	norm := strings.ToLower(jsLowerRepl.Replace(p))
	segs := splitNonEmpty(norm, "/")
	for _, s := range segs {
		if slices.Contains(denySegments, s) {
			return tr.T("electron.common.protected-folder", s)
		}
	}
	for _, f := range denyFragments {
		if strings.Contains(norm, f) {
			return tr.T("electron.common.browser-system-credential-folder")
		}
	}
	name := ""
	if len(segs) > 0 {
		name = segs[len(segs)-1]
	}
	for _, re := range denyNames {
		if re.MatchString(name) {
			return tr.T("electron.common.protected-file", name)
		}
	}
	return ""
}

func (env GuardEnv) realpath(p string) (string, error) {
	if env.Realpath != nil {
		return env.Realpath(p)
	}
	return RealpathNative(p)
}

func realOrParent(p string, env GuardEnv) (string, bool, bool) {
	r, err := env.realpath(p)
	if err == nil {
		return r, true, true
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", false, false
	}
	P := lib(env.Platform)
	parent := P.Dirname(p)
	if parent == p {
		return "", false, false
	}
	pr, err := env.realpath(parent)
	if err != nil {
		return "", false, false
	}
	return P.Join(pr, P.Basename(p)), false, true
}

// GuardOpts：need 'read' | 'write'
type GuardOpts struct {
	Need         string
	AllowMissing bool
}

func scopeMatch(s Scope, p, sp, platform string) bool {
	if s.Kind == "file" {
		return IsInside(p, sp, platform) && IsInside(sp, p, platform)
	}
	return IsInside(p, sp, platform)
}

// GuardPath 对应 guardPath
func GuardPath(input any, env GuardEnv, opts GuardOpts) GuardResult {
	norm, bad := NormalizeInput(input, env.Home, env.Platform)
	if bad != nil {
		return *bad
	}
	if d := DenyReason(norm, env.Platform, env.DenyRoots); d != "" {
		return GuardResult{Code: "denied", Message: tr.T("electron.common.access-denied", d)}
	}
	lexical := false
	for _, s := range env.Scopes {
		if scopeMatch(s, norm, s.Path, env.Platform) {
			lexical = true
			break
		}
	}
	outside := GuardResult{Code: "outside_scope", Message: tr.T("electron.common.path-is-not-inside-a-granted-folder")}
	real, exists, ok := realOrParent(norm, env)
	if !ok {
		if lexical {
			return GuardResult{Code: "not_found", Message: tr.T("electron.common.file-or-its-parent-folder-doesn-t-exist")}
		}
		return outside
	}
	if !exists && !opts.AllowMissing {
		if lexical {
			return GuardResult{Code: "not_found", Message: tr.T("electron.common.file-doesn-t-exist")}
		}
		return outside
	}
	if d := DenyReason(real, env.Platform, env.DenyRoots); d != "" {
		return GuardResult{Code: "denied", Message: tr.T("electron.common.access-denied", d)}
	}
	for _, s := range env.Scopes {
		sr, err := env.realpath(s.Path)
		if err != nil {
			continue
		}
		if !scopeMatch(s, real, sr, env.Platform) {
			continue
		}
		if opts.Need == "write" && s.Mode != "read-write" {
			return GuardResult{Code: "read_only", Message: tr.T("electron.common.this-folder-is-granted-read-only")}
		}
		return GuardResult{OK: true, Real: real, Scope: s, Exists: exists}
	}
	if lexical {
		return GuardResult{Code: "symlink_escape", Message: tr.T("electron.common.symlink-points-outside-the-granted-scope")}
	}
	return outside
}
