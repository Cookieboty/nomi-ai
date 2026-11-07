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

// 整条消息到结尾只能是「拒绝那一行 + 标签那一行」：路径里夹着换行与伪造的 nomi-sbx: 标签时，消息会多出几行，对不上就丢弃
var denialRe = regexp.MustCompile(`Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+) ([^\n]*)\n` + regexp.QuoteMeta(Tag) + `([A-Za-z0-9]+):(\S+)\s*$`)

// hasControl：路径里有控制字符（换行、回车等）：不是正常的文件路径，多半是伪造的日志
func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// ParseDenial：解析一条 eventMessage（可能带「N duplicate report for」前缀）
func ParseDenial(msg string) (Denial, bool) {
	m := denialRe.FindStringSubmatch(msg)
	if m == nil {
		return Denial{}, false
	}
	path := strings.ReplaceAll(m[4], `\/`, "/")
	if hasControl(path) {
		return Denial{}, false
	}
	return Denial{Proc: m[1], Pid: m[2], Op: m[3], Path: path, Token: m[5], Rule: m[6]}, true
}

// Request：拒绝归成用户能授权的一项
type Request struct {
	// Kind：category（按类别读写）/ read（读这一个文件，密钥文件按文件授权）/ folder（写这个文件夹）/ file（写这个文件）/
	// protected（受保护，只能去设置里取消保护）
	Kind  string
	Value string
}

// Key：同一项授权的去重键
func (r Request) Key() string { return r.Kind + ":" + r.Value }

// Classify：把拒绝归成一项授权请求；Nomi 自己的数据目录不让授权（ok = false）
func Classify(d Denial, home string) (Request, bool) {
	switch {
	case d.Rule == "read:secret-files":
		// 密钥文件分散在各处，按文件授权（只放开这一个 .env，不是全部）
		return Request{Kind: "read", Value: d.Path}, true
	case strings.HasPrefix(d.Rule, "read:") && CategoryByID(strings.TrimPrefix(d.Rule, "read:")) != nil:
		return Request{Kind: "category", Value: strings.TrimPrefix(d.Rule, "read:")}, true
	case d.Rule == "read:protected" || d.Rule == "write:protected":
		return Request{Kind: "protected", Value: d.Path}, true
	case d.Rule == "write":
		// 开机自启、PATH 里的可执行目录、shell 配置：写进去等于在沙箱外长期执行，一律不给授权
		if NeverGrantable(d.Path, home) {
			return Request{}, false
		}
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

// neverGrantHome：相对主目录、永不授权写入的位置（开机自启、PATH 里的可执行目录、shell 配置）
var neverGrantHome = []string{
	"Library/LaunchAgents", ".local/bin", "bin", "go/bin", ".cargo/bin", ".bun/bin", ".deno/bin",
	".oh-my-zsh", ".zsh", ".config/fish", ".config/zsh",
}

// neverGrantFiles：相对主目录、永不授权写入的文件（shell 启动脚本、git 全局配置可以挂钩子 / 别名执行命令）
var neverGrantFiles = []string{
	".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login",
	".bash_logout", ".profile", ".gitconfig",
}

var neverGrantAbs = []string{"/Library/LaunchAgents", "/Library/LaunchDaemons", "/usr/local/bin", "/opt/homebrew/bin"}

// NeverGrantable：写这个路径（或它所在的文件夹）永远不给授权
func NeverGrantable(p, home string) bool {
	p = filepath.Clean(p)
	for _, d := range neverGrantAbs {
		if isInside(p, d) {
			return true
		}
	}
	for _, h := range variants(home) {
		for _, d := range neverGrantHome {
			if isInside(p, filepath.Join(h, d)) {
				return true
			}
		}
		for _, f := range neverGrantFiles {
			if p == filepath.Join(h, f) {
				return true
			}
		}
	}
	return false
}

// grantFolder：被拒的写要授权哪个文件夹：从这个文件所在的文件夹起往上找最近的 git 仓库根；不在仓库里就是这个文件夹本身。
// 只取最小的范围：不会因为一次点击把 ~/Projects 这类大文件夹整个放开。太宽的（主目录、大文件夹）返回 ""，
// 改为只授权这一个文件
func grantFolder(p, home string) string {
	p = filepath.Clean(p)
	start := filepath.Dir(p)
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		start = p
	}
	if IsBroad(start, home) || NeverGrantable(start, home) {
		return ""
	}
	for d := start; !IsBroad(d, home); d = filepath.Dir(d) {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		if filepath.Dir(d) == d {
			break
		}
	}
	return start
}
