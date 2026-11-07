// Package sandbox：编程助手子进程的系统级沙箱（docs/development/security.md「编程助手」）。
//
// macOS 用 sandbox-exec + Nomi 生成的 Seatbelt 配置：默认放行，按类别拒读敏感位置的内容
// （SSH / 云凭据 / 密钥库 / 浏览器 / 个人数据 / 密钥文件、用户的受保护文件夹、Nomi 自己的数据目录），
// 写只放行项目目录、CLI 自己的配置与缓存、临时目录与用户授权过的位置。每条拒绝都带
// `nomi-sbx:<token>:<rule>` 消息，违规日志（monitor_darwin.go）据此找回标签并分类，让用户授权。
//
// Seatbelt 不能嵌套（外层有拒绝规则时内层 sandbox_apply 失败），所以包起来的 CLI 要关掉自己的沙箱
// （Codex 用 danger-full-access、Gemini 设 GEMINI_SANDBOX=false 等），由这一层做边界。
// 其他平台暂不支持（Supported() = false），CLI 照旧运行。
package sandbox

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Exec：sandbox-exec 的位置
const Exec = "/usr/bin/sandbox-exec"

// Tag：违规日志里认 Nomi 规则的前缀
const Tag = "nomi-sbx:"

// Supported：当前平台能不能用沙箱
func Supported() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	_, err := os.Stat(Exec)
	return err == nil
}

// Category：一类拒读的敏感位置；用户可以按类别授权（本会话 / 始终）
type Category struct {
	ID string
	// Dirs：相对主目录的文件夹（整棵拒读）
	Dirs []string
	// Files：相对主目录的正则（文件名规则，只在主目录下生效，不碰系统证书等）
	Files []string
	// Except：Files 命中但仍然放行的正则（如 .env.example）
	Except []string
}

// Categories：拒读的类别（顺序即界面顺序）。钥匙串不在里面：拒读钥匙串文件会让 CLI 的官方登录失效，
// 钥匙串条目由系统自己的访问控制保护。
var Categories = []Category{
	{ID: "ssh", Dirs: []string{".ssh", ".config/gh"}, Files: []string{`/\.git-credentials$`, `/\.netrc$`}},
	// 包管理器的发布令牌（主目录下的 .npmrc / .pypirc，项目里的不拦）也算云账号凭据
	{ID: "cloud", Dirs: []string{".aws", ".azure", ".config/gcloud", ".kube", ".docker", ".oci", ".terraform.d",
		".npmrc", ".pypirc", ".gem/credentials"}},
	{ID: "keys", Dirs: []string{".gnupg", ".password-store", ".config/op"}, Files: []string{`\.kdbx?$`}},
	{ID: "browser", Dirs: []string{
		"Library/Application Support/Google/Chrome", "Library/Application Support/Firefox",
		"Library/Application Support/Microsoft Edge", "Library/Application Support/BraveSoftware",
		"Library/Application Support/Arc", "Library/Application Support/Chromium", "Library/Application Support/Vivaldi",
		"Library/Application Support/com.operasoftware.Opera", "Library/Safari", "Library/Cookies",
		".mozilla", ".config/google-chrome", ".config/chromium", ".config/vivaldi", ".config/opera",
	}},
	{ID: "personal", Dirs: []string{
		"Library/Mail", "Library/Messages", "Library/Calendars", "Library/Application Support/AddressBook",
		"Library/Group Containers/group.com.apple.notes", "Pictures/Photos Library.photoslibrary",
		// 命令行与 REPL 的历史里常有贴进去的令牌、密码
		".zsh_history", ".bash_history", ".zsh_sessions", ".local/share/fish/fish_history", ".python_history",
		".node_repl_history", ".psql_history", ".mysql_history",
	}},
	{ID: "secret-files", Files: []string{
		`/\.env(\.[^/]*)?$`, `\.(key|p12|pfx|keystore|jks)$`, `[-_.](key|private)[^/]*\.pem$`,
	}, Except: []string{`/\.env\.(example|sample|template|dist|defaults)$`}},
}

// CategoryByID：按 id 找类别
func CategoryByID(id string) *Category {
	for i := range Categories {
		if Categories[i].ID == id {
			return &Categories[i]
		}
	}
	return nil
}

// writableHome：相对主目录、默认可写的位置（CLI 自己的配置、包管理器与构建缓存）
var writableHome = []string{
	".claude", ".codex", ".gemini", ".grok", ".dsh", ".local/share/claude", ".local/state/claude",
	".cache", "Library/Caches", "Library/Logs", ".npm", ".pnpm-store", "Library/pnpm", ".local/share/pnpm", ".yarn", ".bun",
	".node-gyp", ".config/configstore", ".config/yarn", ".config/pnpm", ".deno", "go/pkg", ".cargo/registry", ".cargo/git",
	".rustup", ".gradle", ".m2", ".ivy2", ".sbt", ".gem", ".bundle", ".cocoapods", ".android", ".expo", ".dotnet", ".nuget",
	".swiftpm", "Library/Developer/Xcode/DerivedData", "Library/Developer/CoreSimulator", ".local/share/virtualenv",
	".local/share/uv", ".jupyter", ".ipython", ".matplotlib", ".streamlit", ".vercel", ".turbo",
}

// execConfigHome：相对主目录、在可写位置里但不让写的东西：改了之后用户在沙箱外运行时会执行命令（CLI 的钩子与配置、
// 构建工具的初始化脚本、装进 PATH 的可执行目录）。CLI 照样能写自己目录里的会话、日志与缓存
var execConfigHome = []string{
	".claude/settings.json", ".claude/hooks", ".codex/config.toml", ".gemini/settings.json",
	".gradle/init.d", ".gradle/init.gradle", ".gradle/init.gradle.kts", ".bun/bin", ".deno/bin",
}

// 本机 Unix socket：拿到它们等于绕过拒读（ssh-agent 里的私钥、Docker 守护进程）。没授权对应类别时不让连
var (
	agentSockets  = []string{`^/private/(var/run|tmp)/com\.apple\.launchd\.[^/]+/Listeners$`, `/agent\.sock$`, `/S\.gpg-agent(\.ssh)?$`}
	dockerSockets = []string{`/docker\.sock$`}
)

func socketDeny(b *strings.Builder, regexes []string, msg string) {
	if len(regexes) == 0 {
		return
	}
	b.WriteString("(deny network-outbound (with message \"" + esc(msg) + "\")")
	for _, re := range regexes {
		b.WriteString(" (remote unix-socket (path-regex #\"" + re + "\"))")
	}
	b.WriteString(")\n")
}

// writableHomeRegex：相对主目录的可写文件（Claude Code 原子写 ~/.claude.json 用同目录临时文件）
var writableHomeRegex = []string{`/\.claude\.json[^/]*$`}

// writableAbs：系统里可写的位置
var writableAbs = []string{"/dev", "/private/tmp", "/private/var/folders"}

// Spec：一次启动的沙箱配置
type Spec struct {
	Token       string
	Home        string
	Cwd         string
	CwdWritable bool
	// NomiData：Nomi 的数据目录（拒读拒写），ReadAllow / Writable 里的子目录除外
	NomiData  string
	ReadAllow []string
	// Writable：额外可写的文件夹（CLI 的官方账号目录、用户授权过的文件夹）；WritableFiles 是单个文件
	Writable      []string
	WritableFiles []string
	// Protected：用户的受保护文件夹（拒读拒写，不能在会话里授权）
	Protected []string
	// Granted：用户授权过的类别 id（不再拒读）
	Granted map[string]bool
	// ReadFiles：单独授权读取的文件（如项目里的某个 .env）
	ReadFiles []string
}

// Rule：违规消息里的规则（read:<类别> / read:protected / read:nomi / write / write:protected / write:nomi）
func ruleMsg(token, rule string) string { return Tag + token + ":" + rule }

// Profile：生成 Seatbelt 配置。规则按「后写的优先」排：先拒，再按需放行，最后再拒受保护的位置。
func Profile(s Spec) string {
	var b strings.Builder
	b.WriteString("(version 1)\n(allow default)\n")
	home := realDir(s.Home)
	// ── 读 ──
	for _, c := range Categories {
		if s.Granted[c.ID] {
			continue
		}
		var filters []string
		for _, d := range c.Dirs {
			filters = append(filters, subpaths(filepath.Join(s.Home, d))...)
		}
		for _, re := range c.Files {
			filters = append(filters, fileRegexes(fileRoots(s), re)...)
		}
		denyRead(&b, filters, ruleMsg(s.Token, "read:"+c.ID))
		var except []string
		for _, re := range c.Except {
			except = append(except, regexFilter(re))
		}
		allow(&b, "file-read-data", except)
	}
	var readFiles []string
	for _, f := range s.ReadFiles {
		readFiles = append(readFiles, literals(f)...)
	}
	allow(&b, "file-read-data", readFiles)
	if s.NomiData != "" {
		denyRead(&b, subpaths(s.NomiData), ruleMsg(s.Token, "read:nomi"))
		var ok []string
		for _, p := range append(append([]string{}, s.ReadAllow...), s.Writable...) {
			if isInside(p, s.NomiData) {
				ok = append(ok, subpaths(p)...)
			}
		}
		allow(&b, "file-read-data", ok)
	}
	var prot []string
	for _, p := range s.Protected {
		prot = append(prot, subpaths(p)...)
	}
	denyRead(&b, prot, ruleMsg(s.Token, "read:protected"))
	// ── 写 ──
	b.WriteString("(deny file-write* (with message \"" + esc(ruleMsg(s.Token, "write")) + "\"))\n")
	var w []string
	if s.CwdWritable && s.Cwd != "" {
		w = append(w, subpaths(s.Cwd)...)
	}
	for _, p := range writableAbs {
		w = append(w, subpathFilter(p))
	}
	if t := os.TempDir(); t != "" {
		w = append(w, subpaths(t)...)
	}
	for _, d := range writableHome {
		w = append(w, subpaths(filepath.Join(s.Home, d))...)
	}
	for _, re := range writableHomeRegex {
		w = append(w, regexFilter("^"+regexp.QuoteMeta(home)+re))
	}
	for _, p := range s.Writable {
		w = append(w, subpaths(p)...)
	}
	for _, c := range Categories {
		if s.Granted[c.ID] {
			for _, d := range c.Dirs {
				w = append(w, subpaths(filepath.Join(s.Home, d))...)
			}
		}
	}
	for _, f := range s.WritableFiles {
		w = append(w, literals(f)...)
	}
	allow(&b, "file-write*", w)
	var execCfg []string
	for _, d := range execConfigHome {
		execCfg = append(execCfg, subpaths(filepath.Join(s.Home, d))...)
	}
	b.WriteString(denyClause("file-write*", execCfg, ruleMsg(s.Token, "write:config")))
	// ── 本机 socket 与 Apple Events ──
	if !s.Granted["ssh"] {
		socketDeny(&b, agentSockets, ruleMsg(s.Token, "connect:ssh"))
	}
	if !s.Granted["cloud"] {
		socketDeny(&b, dockerSockets, ruleMsg(s.Token, "connect:cloud"))
	}
	// osascript 等能让别的应用（终端、Finder）在沙箱外替它做事
	b.WriteString("(deny appleevent-send (with message \"" + esc(ruleMsg(s.Token, "appleevents")) + "\"))\n")
	if s.NomiData != "" {
		b.WriteString(denyClause("file-write*", subpaths(s.NomiData), ruleMsg(s.Token, "write:nomi")))
		var ok []string
		for _, p := range s.Writable {
			if isInside(p, s.NomiData) {
				ok = append(ok, subpaths(p)...)
			}
		}
		allow(&b, "file-write*", ok)
	}
	b.WriteString(denyClause("file-write*", prot, ruleMsg(s.Token, "write:protected")))
	return b.String()
}

// Wrap：把一次启动包进沙箱
func Wrap(file string, args []string, profile string) (string, []string) {
	return Exec, append([]string{"-p", profile, file}, args...)
}

// fileRoots：文件名规则生效的根：主目录，以及不在主目录下的项目目录
func fileRoots(s Spec) []string {
	roots := []string{realDir(s.Home)}
	if s.Cwd != "" {
		if c := realDir(s.Cwd); !isInside(c, roots[0]) {
			roots = append(roots, c)
		}
	}
	return roots
}

// fileRegexes：以 / 开头的规则按完整文件名匹配（/\.env$ 不会命中 foo.env），否则按后缀匹配
func fileRegexes(roots []string, re string) []string {
	out := []string{}
	for _, r := range roots {
		if rest, ok := strings.CutPrefix(re, "/"); ok {
			out = append(out, regexFilter("^"+regexp.QuoteMeta(r)+"/(.*/)?"+rest))
		} else {
			out = append(out, regexFilter("^"+regexp.QuoteMeta(r)+"/.*"+re))
		}
	}
	return out
}

func denyRead(b *strings.Builder, filters []string, msg string) {
	b.WriteString(denyClause("file-read-data", filters, msg))
}

func denyClause(op string, filters []string, msg string) string {
	if len(filters) == 0 {
		return ""
	}
	return "(deny " + op + " " + strings.Join(filters, " ") + " (with message \"" + esc(msg) + "\"))\n"
}

func allow(b *strings.Builder, op string, filters []string) {
	if len(filters) == 0 {
		return
	}
	b.WriteString("(allow " + op + " " + strings.Join(filters, " ") + ")\n")
}

// subpaths：路径与它的 realpath（Seatbelt 按真实路径匹配，/tmp → /private/tmp）
func subpaths(p string) []string {
	out := []string{}
	for _, x := range variants(p) {
		out = append(out, subpathFilter(x))
	}
	return out
}

func literals(p string) []string {
	out := []string{}
	for _, x := range variants(p) {
		out = append(out, "(literal \""+esc(x)+"\")")
	}
	return out
}

func variants(p string) []string {
	if p == "" {
		return nil
	}
	clean := filepath.Clean(p)
	out := []string{clean}
	if r := realDir(clean); r != clean {
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

func subpathFilter(p string) string { return "(subpath \"" + esc(p) + "\")" }

func regexFilter(re string) string { return "(regex #\"" + strings.ReplaceAll(re, `"`, `\"`) + "\")" }

func esc(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`)
}

// realDir：realpath；路径还不存在时解析最近的已存在上级再拼回去
func realDir(p string) string {
	if p == "" {
		return p
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	parent := filepath.Dir(p)
	if parent == p {
		return p
	}
	return filepath.Join(realDir(parent), filepath.Base(p))
}

func isInside(child, parent string) bool {
	rel, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
