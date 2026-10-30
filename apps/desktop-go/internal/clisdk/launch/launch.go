// Package launch mirrors apps/desktop-electron/internal/cli-sdk/src/launch/index.ts：启动注入的通用实现——
// 环境变量叠加与剔除、进程级文件、规范化目录、共享软链（Windows 目录用 junction）、私有 HOME。
package launch

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"golang.org/x/text/unicode/norm"
)

// ApplyLaunchEnv：{...base} 删 strip，再 {...out, ...env}（已有键保位、新键追加，同 JS 对象展开）。
func ApplyLaunchEnv(base *util.Obj, env *util.Obj, strip []string) *util.Obj {
	out := util.NewObj()
	for _, k := range base.Keys() {
		out.Set(k, base.Get(k))
	}
	for _, k := range strip {
		out.Delete(k)
	}
	if env != nil {
		for _, k := range env.Keys() {
			out.Set(k, env.Get(k))
		}
	}
	return out
}

// File = AgentLaunch.files 元素。
type File struct {
	Path    string
	Content string
	Mode    *os.FileMode
}

// WriteLaunchFiles：目录 0700、文件默认 0600；返回写下的路径。失败时返回 Node 形态错误信息（throw 语义）。
func WriteLaunchFiles(files []File) ([]string, error) {
	written := []string{}
	for _, f := range files {
		mode := os.FileMode(0o600)
		if f.Mode != nil {
			mode = *f.Mode
		}
		if err := mkdirp(filepath.Dir(f.Path), 0o700); err != nil {
			return written, &NodeError{nodeErrMessage(err, "mkdir", filepath.Dir(f.Path))}
		}
		// writeFileSync(path, content, {mode})：O_WRONLY|O_CREAT|O_TRUNC，mode 只在新建时生效
		if err := os.WriteFile(f.Path, []byte(f.Content), mode); err != nil {
			return written, &NodeError{nodeErrMessage(err, "open", f.Path)}
		}
		_ = os.Chmod(f.Path, mode) // Windows 上 mode 无效
		written = append(written, f.Path)
	}
	return written, nil
}

// NodeError 承载 Node 风格 message。
type NodeError struct{ Msg string }

func (e *NodeError) Error() string { return e.Msg }

var trailingSep = regexp.MustCompile(`[\\/]+$`)

func nfc(s string) string { return norm.NFC.String(s) }

// jsDirname / jsBasename：Node path.dirname/basename（空串分别为 "." / ""）。
func jsDirname(p string) string {
	if p == "" {
		return "."
	}
	return filepath.Dir(p)
}

func jsBasename(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Base(p)
}

// jsJoin = path.join（全空 → "."）。
func jsJoin(parts ...string) string {
	j := filepath.Join(parts...)
	if j == "" {
		return "."
	}
	return j
}

// CanonicalDir：绝对、NFC、无结尾分隔符、父目录经 realpath.native。
func CanonicalDir(p string) string {
	abs, _ := filepath.Abs(p)
	abs = trailingSep.ReplaceAllString(nfc(abs), "")
	rest := []string{}
	cur := abs
	for {
		if real, err := realpathNative(cur); err == nil {
			parts := []string{nfc(real)}
			for i := len(rest) - 1; i >= 0; i-- {
				parts = append(parts, rest[i])
			}
			return trailingSep.ReplaceAllString(jsJoin(parts...), "")
		}
		parent := jsDirname(cur)
		if parent == cur {
			return abs
		}
		rest = append(rest, jsBasename(cur))
		cur = parent
	}
}

// LinkProblem = { entry, reason }。
type LinkProblem struct {
	Entry  string `json:"entry"`
	Reason string `json:"reason"`
}

// LinkShared：已是指向 target 的软链 → 不动；其他软链 → 删后重建；真实文件/目录 → 保留。失败返回原因（"" = 成功）。
func LinkShared(target, link string, dir bool, platform string) string {
	if st, err := os.Lstat(link); err == nil {
		if isLink(st) {
			if cur, err := readlinkNode(link); err == nil && cur == target {
				return ""
			}
			_ = os.RemoveAll(link)
		} else {
			return ""
		}
	}
	if err := mkdirp(jsDirname(link), 0o777); err != nil {
		return nodeErrMessage(err, "mkdir", jsDirname(link))
	}
	kind := "file"
	if dir {
		kind = "dir"
		if platform == "win32" {
			kind = "junction"
		}
	}
	if err := symlinkNode(target, link, kind); err != nil {
		return nodeErrMessage(err, "symlink", target, link)
	}
	return ""
}

// EnsureSharedHome：私有目录（0700）+ 按布局表软链回 userDir 的条目。
func EnsureSharedHome(dir, userDir string, entries []clisdk.SharedEntry, platform string) ([]LinkProblem, error) {
	if err := mkdirp(dir, 0o700); err != nil {
		return nil, &NodeError{nodeErrMessage(err, "mkdir", dir)}
	}
	_ = os.Chmod(dir, 0o700)
	problems := []LinkProblem{}
	for _, e := range entries {
		target := jsJoin(userDir, e.Name)
		if _, err := os.Stat(target); err != nil { // existsSync 跟随软链
			if !e.CreateIfMissing {
				continue
			}
			if e.Dir {
				if err := mkdirp(target, 0o777); err != nil {
					return problems, &NodeError{nodeErrMessage(err, "mkdir", target)}
				}
			}
		}
		if reason := LinkShared(target, jsJoin(dir, e.Name), e.Dir, platform); reason != "" {
			problems = append(problems, LinkProblem{Entry: e.Name, Reason: reason})
		}
	}
	return problems, nil
}

// EnsurePrivateHome：userDir 顶层条目中匹配 shared、且不匹配任一 keepPrivate 的软链进 dir（正则为 JS 语法）。
func EnsurePrivateHome(dir, userDir, shared string, keepPrivate []string, platform string) ([]LinkProblem, error) {
	sh, err := clisdk.NewJSRegExp(shared, "")
	if err != nil {
		return nil, err
	}
	keep := []*clisdk.JSRegExp{}
	for _, r := range keepPrivate {
		k, err := clisdk.NewJSRegExp(r, "")
		if err != nil {
			return nil, err
		}
		keep = append(keep, k)
	}
	names := readdirNames(userDir)
	entries := []clisdk.SharedEntry{}
	for _, name := range names {
		if !sh.Test(name) {
			continue
		}
		skip := false
		for _, k := range keep {
			if k.Test(name) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		st, err := os.Stat(jsJoin(userDir, name))
		if err != nil {
			continue
		}
		entries = append(entries, clisdk.SharedEntry{Name: name, Dir: st.IsDir()})
	}
	return EnsureSharedHome(dir, userDir, entries, platform)
}

// readdirNames = fs.readdirSync（OS 原序，失败 → []）。
func readdirNames(d string) []string {
	f, err := os.Open(d)
	if err != nil {
		return nil
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil
	}
	return names
}

func isLink(st os.FileInfo) bool { return st.Mode()&os.ModeSymlink != 0 || isJunction(st) }

var _ = strings.TrimSpace
