// Package nodepath：Node path.posix / path.win32 的子集（与 core/desktop/node_path.go 同源，供 core/cli 等不依赖 desktop 的包使用）。
package nodepath

import (
	"os"
	"path"
	"regexp"
	"runtime"
	"strings"
)

// PathLib 是 Node path.posix / path.win32 中桌面能力用到的部分（pathGuard 与 workspace 按 platform 选择）
type PathLib interface {
	IsAbsolute(p string) bool
	Resolve(ps ...string) string
	Relative(from, to string) string
	Dirname(p string) string
	Join(ps ...string) string
	Basename(p string) string
	Root(p string) string
}

// Platform 返回 Node 的 process.platform 名称
func Platform() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	default:
		return runtime.GOOS
	}
}

func Lib(platform string) PathLib {
	if platform == "win32" {
		return win32Path{}
	}
	return posixPath{}
}

type posixPath struct{}

func (posixPath) IsAbsolute(p string) bool { return strings.HasPrefix(p, "/") }

func (posixPath) Resolve(ps ...string) string {
	acc := ""
	abs := false
	for i := len(ps) - 1; i >= 0 && !abs; i-- {
		if ps[i] == "" {
			continue
		}
		acc = ps[i] + "/" + acc
		abs = strings.HasPrefix(ps[i], "/")
	}
	if !abs {
		cwd, _ := os.Getwd()
		acc = cwd + "/" + acc
	}
	return path.Clean("/" + acc)
}

func (p posixPath) Relative(from, to string) string {
	f, t := p.Resolve(from), p.Resolve(to)
	if f == t {
		return ""
	}
	return relSegs(splitNonEmpty(f, "/"), splitNonEmpty(t, "/"), "/", func(a, b string) bool { return a == b })
}

func (p posixPath) Dirname(s string) string {
	if s == "" {
		return "."
	}
	s2 := strings.TrimRight(s, "/")
	if s2 == "" {
		return "/"
	}
	i := strings.LastIndex(s2, "/")
	if i < 0 {
		return "."
	}
	if i == 0 {
		return "/"
	}
	return strings.TrimRight(s2[:i], "/")
}

func (posixPath) Join(ps ...string) string {
	nonEmpty := []string{}
	for _, s := range ps {
		if s != "" {
			nonEmpty = append(nonEmpty, s)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	j := strings.Join(nonEmpty, "/")
	c := path.Clean(j)
	if strings.HasSuffix(j, "/") && c != "/" {
		c += "/"
	}
	return c
}

func (posixPath) Basename(s string) string {
	s = strings.TrimRight(s, "/")
	if i := strings.LastIndex(s, "/"); i >= 0 {
		return s[i+1:]
	}
	return s
}

func (posixPath) Root(s string) string {
	if strings.HasPrefix(s, "/") {
		return "/"
	}
	return ""
}

func splitNonEmpty(s, sep string) []string {
	out := []string{}
	for _, x := range strings.Split(s, sep) {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

func relSegs(f, t []string, sep string, eq func(a, b string) bool) string {
	i := 0
	for i < len(f) && i < len(t) && eq(f[i], t[i]) {
		i++
	}
	parts := []string{}
	for j := i; j < len(f); j++ {
		parts = append(parts, "..")
	}
	parts = append(parts, t[i:]...)
	return strings.Join(parts, sep)
}

type win32Path struct{}

var winDrive = regexp.MustCompile(`^[a-zA-Z]:`)

func (win32Path) IsAbsolute(p string) bool {
	if p == "" {
		return false
	}
	if p[0] == '\\' || p[0] == '/' {
		return true
	}
	return len(p) >= 3 && winDrive.MatchString(p) && (p[2] == '\\' || p[2] == '/')
}

// split 返回（盘符 "C:" 或 ""，是否从根开始，各段）
func winSplit(p string) (string, bool, []string) {
	drive := ""
	if winDrive.MatchString(p) {
		drive, p = p[:2], p[2:]
	}
	rooted := p != "" && (p[0] == '\\' || p[0] == '/')
	segs := []string{}
	for _, s := range strings.FieldsFunc(p, func(r rune) bool { return r == '\\' || r == '/' }) {
		segs = append(segs, s)
	}
	return drive, rooted, segs
}

func winNormSegs(segs []string, rooted bool) []string {
	out := []string{}
	for _, s := range segs {
		switch s {
		case ".":
		case "..":
			if len(out) > 0 && out[len(out)-1] != ".." {
				out = out[:len(out)-1]
			} else if !rooted {
				out = append(out, "..")
			}
		default:
			out = append(out, s)
		}
	}
	return out
}

func (w win32Path) Resolve(ps ...string) string {
	drive := ""
	rooted := false
	var segs []string
	for i := len(ps) - 1; i >= 0; i-- {
		if ps[i] == "" {
			continue
		}
		d, r, s := winSplit(ps[i])
		if drive != "" && d != "" && !strings.EqualFold(d, drive) {
			continue
		}
		if drive == "" {
			drive = d
		}
		segs = append(append([]string{}, s...), segs...)
		if r {
			rooted = true
		}
		if rooted && drive != "" {
			break
		}
	}
	if !rooted || drive == "" {
		cwd, _ := os.Getwd()
		d, _, s := winSplit(strings.ReplaceAll(cwd, "/", "\\"))
		if drive == "" {
			drive = d
		}
		if !rooted {
			segs = append(append([]string{}, s...), segs...)
		}
		rooted = true
	}
	return drive + "\\" + strings.Join(winNormSegs(segs, true), "\\")
}

func (w win32Path) Relative(from, to string) string {
	f, t := w.Resolve(from), w.Resolve(to)
	if strings.EqualFold(f, t) {
		return ""
	}
	fd, _, fs := winSplit(f)
	td, _, ts := winSplit(t)
	if !strings.EqualFold(fd, td) {
		return t
	}
	return relSegs(fs, ts, "\\", strings.EqualFold)
}

func (w win32Path) Dirname(p string) string {
	drive, rooted, segs := winSplit(p)
	root := drive
	if rooted {
		root += "\\"
	}
	if len(segs) <= 1 {
		if root == "" {
			return "."
		}
		return root
	}
	return root + strings.Join(segs[:len(segs)-1], "\\")
}

func (w win32Path) Join(ps ...string) string {
	nonEmpty := []string{}
	for _, s := range ps {
		if s != "" {
			nonEmpty = append(nonEmpty, s)
		}
	}
	if len(nonEmpty) == 0 {
		return "."
	}
	j := strings.Join(nonEmpty, "\\")
	drive, rooted, segs := winSplit(j)
	out := drive
	if rooted {
		out += "\\"
	}
	out += strings.Join(winNormSegs(segs, rooted), "\\")
	if out == "" {
		return "."
	}
	return out
}

func (win32Path) Basename(p string) string {
	_, _, segs := winSplit(p)
	if len(segs) == 0 {
		return ""
	}
	return segs[len(segs)-1]
}

func (win32Path) Root(p string) string {
	drive, rooted, _ := winSplit(p)
	if rooted {
		return drive + "\\"
	}
	return drive
}
