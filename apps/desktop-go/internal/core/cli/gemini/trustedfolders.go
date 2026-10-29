package gemini

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
)

const GeminiTrustFolder = "TRUST_FOLDER"

const (
	lockStaleMs = 10_000
	lockRetries = 50
	lockWaitMs  = 100
)

func envGet(env *util.Obj, k string) (string, bool) {
	if env == nil {
		return "", false
	}
	s, ok := env.Get(k).(string)
	return s, ok
}

// GeminiTrustedFoldersPath = geminiTrustedFoldersPath。
func GeminiTrustedFoldersPath(home string, env *util.Obj) string {
	if v, ok := envGet(env, "GEMINI_CLI_TRUSTED_FOLDERS_PATH"); ok {
		if e := strings.TrimSpace(v); e != "" {
			return nodepath.Lib(nodepath.Platform()).Resolve(e)
		}
	}
	return filepath.Join(usage.GeminiDir(home, env), "trustedFolders.json")
}

// GeminiTrustBlockedByEnv = geminiTrustBlockedByEnv（"" = null）。
func GeminiTrustBlockedByEnv(env *util.Obj) string {
	if v, _ := envGet(env, "GEMINI_CLI_TRUST_WORKSPACE"); v == "false" {
		return "GEMINI_CLI_TRUST_WORKSPACE=false"
	}
	if v, _ := envGet(env, "GEMINI_RESTRICTED_MODE"); v == "true" {
		return "GEMINI_RESTRICTED_MODE=true"
	}
	return ""
}

// GeminiPathKey = geminiPathKey。
func GeminiPathKey(p, platform string) string {
	abs := strings.ReplaceAll(nodepath.Lib(platform).Resolve(p), `\`, "/")
	if platform == "win32" || platform == "darwin" {
		return strings.ToLower(abs)
	}
	return abs
}

// StripJsonComments = stripJsonComments（按 UTF-16 单元扫描；注释与引号均为 ASCII，按字节等价）。
func StripJsonComments(src string) string {
	var out strings.Builder
	i, inStr := 0, false
	for i < len(src) {
		c := src[i]
		var n byte
		hasN := i+1 < len(src)
		if hasN {
			n = src[i+1]
		}
		if inStr {
			if c == '\\' && hasN {
				// 下一个"字符"整段写出（多字节 UTF-8 的首字节之后的续字节无论如何都会原样复制）
				out.WriteByte(c)
				out.WriteByte(n)
				i += 2
				continue
			}
			out.WriteByte(c)
			if c == '"' {
				inStr = false
			}
			i++
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out.WriteByte(c)
			i++
		case c == '/' && n == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '/' && n == '*':
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				i = len(src)
			} else {
				i = i + 2 + end + 2
			}
		default:
			out.WriteByte(c)
			i++
		}
	}
	return out.String()
}

func parseTrustFile(file, content string) (*util.Obj, error) {
	if util.JSTrim(content) == "" {
		return util.NewObj(), nil
	}
	v, err := util.ParseString(StripJsonComments(content))
	if o, ok := v.(*util.Obj); err == nil && ok && o != nil {
		return o, nil
	}
	return nil, errors.New(i18n.T("electron.common.gemini-s-trusted-folders-list-is-malformed-so", file))
}

func withLock[T any](file string, fn func() (T, error)) (T, error) {
	var zero T
	real := file
	if r, err := filepath.EvalSymlinks(file); err == nil {
		real = r
	}
	lock := real + ".lock"
	for i := 0; ; i++ {
		err := os.Mkdir(lock, 0o777)
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrExist) {
			return zero, err
		}
		st, serr := os.Stat(lock)
		if serr != nil {
			continue
		}
		if time.Since(st.ModTime()).Milliseconds() > lockStaleMs {
			os.RemoveAll(lock)
			continue
		}
		if i >= lockRetries {
			return zero, fmt.Errorf("%s: %w", i18n.T("electron.common.gemini-is-updating-its-trusted-folders-list-please"), err)
		}
		time.Sleep(lockWaitMs * time.Millisecond)
	}
	defer os.RemoveAll(lock)
	return fn()
}

type msgErr struct {
	msg   string
	cause error
}

func (e *msgErr) Error() string { return e.msg }
func (e *msgErr) Unwrap() error { return e.cause }

func writeAtomic(file, content string) error {
	tmp := fmt.Sprintf("%s.nomi-%d-%d.tmp", file, os.Getpid(), time.Now().UnixMilli())
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	for i := 0; ; i++ {
		err := os.Rename(tmp, file)
		if err == nil {
			return nil
		}
		if i >= 5 || !(errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EBUSY)) {
			return err
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TrustResult = GeminiTrustResult（Previous nil = null）。
type TrustResult struct {
	Folder   string
	File     string
	Previous *string
}

// TrustGeminiFolder = trustGeminiFolder（阻塞）。
func TrustGeminiFolder(folder, home string, env *util.Obj, platform string) (*TrustResult, error) {
	blocked := GeminiTrustBlockedByEnv(env)
	if blocked != "" {
		return nil, errors.New(i18n.T("electron.common.the-environment-variable-makes-gemini-distrust-every-folder", blocked))
	}
	if !filepath.IsAbs(folder) {
		return nil, errors.New(i18n.T("electron.common.invalid-working-directory"))
	}
	real, err := filepath.EvalSymlinks(folder)
	if err == nil {
		if real, err = filepath.Abs(real); err == nil {
			var st os.FileInfo
			if st, err = os.Stat(real); err == nil && !st.IsDir() {
				err = errors.New("not a directory")
			}
		}
	}
	if err != nil {
		return nil, errors.New(i18n.T("electron.common.invalid-working-directory"))
	}
	file := GeminiTrustedFoldersPath(home, env)
	if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
		return nil, err
	}
	return withLock(file, func() (*TrustResult, error) {
		content := ""
		b, err := os.ReadFile(file)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		content = string(b)
		entries, err := parseTrustFile(file, content)
		if err != nil {
			return nil, err
		}
		want := GeminiPathKey(real, platform)
		var existing *string
		for _, k := range entries.Keys() {
			if GeminiPathKey(k, platform) == want {
				k := k
				existing = &k
				break
			}
		}
		key := real
		var previous *string
		if existing != nil {
			key = *existing
			p := util.JSString(entries.Get(*existing))
			previous = &p
		}
		if previous == nil || *previous != GeminiTrustFolder {
			entries.Set(key, GeminiTrustFolder)
			if err := writeAtomic(file, util.StringifyIndent(entries, "  ")+"\n"); err != nil {
				return nil, err
			}
		}
		return &TrustResult{Folder: real, File: file, Previous: previous}, nil
	})
}

// IsBroadGeminiFolder = isBroadGeminiFolder。
func IsBroadGeminiFolder(folder, home string, extra []string, platform string) bool {
	mod := nodepath.Lib(platform)
	key := GeminiPathKey(folder, platform)
	parent := GeminiPathKey(mod.Dirname(mod.Resolve(folder)), platform)
	if key == parent {
		return true
	}
	h := GeminiPathKey(home, platform)
	if key == h || parent == h {
		return true
	}
	for _, x := range extra {
		if x != "" && GeminiPathKey(x, platform) == key {
			return true
		}
	}
	return false
}
