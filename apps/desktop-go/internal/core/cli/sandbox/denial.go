package sandbox

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Denial：违规日志里的一条拒绝（只认带 Nomi 标记的）
type Denial struct {
	Proc  string
	Pid   string
	Op    string // file-read-data / file-write-create …
	Path  string
	Token string
	Rule  string // read:<类别> / read:protected / read:nomi / write / write:protected / write:nomi
}

var denialRe = regexp.MustCompile(`Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+) ([^\n]*)\n` + regexp.QuoteMeta(Tag) + `([A-Za-z0-9]+):(\S+)`)

// ParseDenial：解析一条 eventMessage（可能带「N duplicate report for」前缀）
func ParseDenial(msg string) (Denial, bool) {
	m := denialRe.FindStringSubmatch(msg)
	if m == nil {
		return Denial{}, false
	}
	return Denial{Proc: m[1], Pid: m[2], Op: m[3], Path: strings.ReplaceAll(m[4], `\/`, "/"), Token: m[5], Rule: m[6]}, true
}

// Request：拒绝归成用户能授权的一项
type Request struct {
	// Kind：category（按类别读写）/ folder（写这个文件夹）/ file（写这个文件）/ protected（受保护，只能去设置里取消保护）
	Kind  string
	Value string
}

// Key：同一项授权的去重键
func (r Request) Key() string { return r.Kind + ":" + r.Value }

// Classify：把拒绝归成一项授权请求；Nomi 自己的数据目录不让授权（ok = false）
func Classify(d Denial, home string) (Request, bool) {
	switch {
	case strings.HasPrefix(d.Rule, "read:") && CategoryByID(strings.TrimPrefix(d.Rule, "read:")) != nil:
		return Request{Kind: "category", Value: strings.TrimPrefix(d.Rule, "read:")}, true
	case d.Rule == "read:protected" || d.Rule == "write:protected":
		return Request{Kind: "protected", Value: d.Path}, true
	case d.Rule == "write":
		if c := categoryOf(d.Path, home); c != "" {
			return Request{Kind: "category", Value: c}, true
		}
		if dir := grantFolder(d.Path, home); dir != "" {
			return Request{Kind: "folder", Value: dir}, true
		}
		return Request{Kind: "file", Value: d.Path}, true
	}
	return Request{}, false
}

// categoryOf：路径落在哪个类别的文件夹里
func categoryOf(p, home string) string {
	for _, c := range Categories {
		for _, d := range c.Dirs {
			for _, root := range variants(filepath.Join(home, d)) {
				if isInside(p, root) {
					return c.ID
				}
			}
		}
	}
	return ""
}

// broadHome：主目录下不能整个授权的大文件夹
var broadHome = []string{
	"Documents", "Desktop", "Downloads", "Library", "Library/Application Support", "Library/Preferences",
	"Library/Containers", "Library/Group Containers", "Library/Mobile Documents", "Pictures", "Movies", "Music",
	"OneDrive", ".config", ".local", ".local/share", ".local/state",
}

var broadAbs = []string{
	"/System", "/Library", "/Applications", "/Users", "/home", "/usr", "/usr/local", "/bin", "/sbin", "/etc", "/var", "/opt",
	"/private", "/private/var", "/private/etc", "/Volumes", "/root",
}

// IsBroad：太宽、不能整个授权写入的文件夹（根、主目录及其上级、系统目录、主目录下的大文件夹）
func IsBroad(p, home string) bool {
	p = filepath.Clean(p)
	if filepath.Dir(p) == p {
		return true
	}
	for _, h := range variants(home) {
		if isInside(h, p) {
			return true
		}
		for _, d := range broadHome {
			if p == filepath.Join(h, d) {
				return true
			}
		}
	}
	for _, d := range broadAbs {
		if p == d {
			return true
		}
	}
	return false
}

// grantFolder：被拒的写要授权哪个文件夹：从上往下第一个不太宽的上级（不含这个路径本身，除非它已是文件夹）；
// 都太宽（如 ~/.zshrc）时返回 ""，改为只授权这一个文件
func grantFolder(p, home string) string {
	p = filepath.Clean(p)
	var chain []string
	for x := p; ; x = filepath.Dir(x) {
		chain = append([]string{x}, chain...)
		if filepath.Dir(x) == x {
			break
		}
	}
	for _, a := range chain {
		if a == p {
			if st, err := os.Stat(p); err != nil || !st.IsDir() {
				break
			}
		}
		if !IsBroad(a, home) {
			return a
		}
	}
	return ""
}
