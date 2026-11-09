package desktop

import "strings"

// 对话工作区（cwd）作为隐式读写作用域

var homeContainers = []string{"Documents", "Desktop", "Downloads", "Library", "OneDrive", "Pictures"}

var posixSystem = []string{"/System", "/Library", "/Applications", "/Users", "/home", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/private", "/private/var", "/private/etc", "/tmp", "/private/tmp", "/Volumes", "/root"}

var winSystem = []string{"Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users"}

// WorkspaceEnv：工作区校验的环境
type WorkspaceEnv struct {
	Home      string
	Platform  string
	Realpath  func(string) (string, error)
	DenyRoots []string
	UserDeny  []string
}

// WorkspaceCheck：OK 时 Real，否则 Reason
type WorkspaceCheck struct {
	OK     bool
	Real   string
	Reason string
}

func samePath(a, b, platform string) bool {
	return IsInside(a, b, platform) && IsInside(b, a, platform)
}

// IsBroadWorkspace 工作区根是否过宽
func IsBroadWorkspace(real, home, platform string) bool {
	P := lib(platform)
	abs := P.Resolve(real)
	if P.Dirname(abs) == abs {
		return true
	}
	if home != "" && IsInside(home, abs, platform) {
		return true
	}
	if home != "" {
		for _, c := range homeContainers {
			if samePath(abs, P.Join(home, c), platform) {
				return true
			}
		}
	}
	if platform == "win32" {
		root := P.Root(abs)
		for _, d := range winSystem {
			if samePath(abs, P.Join(root, d), platform) {
				return true
			}
		}
		return false
	}
	for _, d := range posixSystem {
		if samePath(abs, d, platform) {
			return true
		}
	}
	return false
}

// CheckWorkspaceRoot 检查工作区根本身
func CheckWorkspaceRoot(dir string, env WorkspaceEnv) WorkspaceCheck {
	P := lib(env.Platform)
	if dir == "" || !P.IsAbsolute(dir) {
		return WorkspaceCheck{Reason: "not absolute"}
	}
	rp := env.Realpath
	if rp == nil {
		rp = RealpathNative
	}
	real, err := rp(dir)
	if err != nil {
		return WorkspaceCheck{Reason: "missing"}
	}
	for _, p := range []string{dir, real} {
		if d := DenyReasonWith(p, env.Platform, env.DenyRoots, env.UserDeny); d != "" {
			return WorkspaceCheck{Reason: "denied: " + d}
		}
		if IsBroadWorkspace(p, env.Home, env.Platform) {
			return WorkspaceCheck{Reason: "too broad"}
		}
	}
	return WorkspaceCheck{OK: true, Real: real}
}

// Workspace：Nomi 对话这一轮的项目目录（都是 realpath）。Primary 为空 = 没有项目
type Workspace struct {
	ProjectID string
	Primary   string
	Extra     []string
}

// Empty：没有项目
func (w Workspace) Empty() bool { return w.Primary == "" }

// Roots：主文件夹在前
func (w Workspace) Roots() []string {
	if w.Primary == "" {
		return nil
	}
	return append([]string{w.Primary}, w.Extra...)
}

// Scopes：每个文件夹一个读写作用域
func (w Workspace) Scopes() []Scope {
	out := make([]Scope, 0, 1+len(w.Extra))
	for _, r := range w.Roots() {
		out = append(out, WorkspaceScope(r))
	}
	return out
}

// RootOf：p（realpath）落在哪个文件夹里；不在任何一个里返回 ""
func (w Workspace) RootOf(p, platform string) string {
	for _, r := range w.Roots() {
		if IsInside(p, r, platform) {
			return r
		}
	}
	return ""
}

// WorkspaceScope 一个项目文件夹当作读写作用域
func WorkspaceScope(real string) Scope {
	return Scope{ID: "workspace", Path: real, Mode: "read-write", Kind: "folder", GrantedAt: 0}
}

// ResolveInWorkspace 相对路径按工作区解析
func ResolveInWorkspace(input any, root, platform string) any {
	s, ok := input.(string)
	if !ok {
		return input
	}
	p := jsTrim(s)
	if p == "" || p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		return input
	}
	P := lib(platform)
	if P.IsAbsolute(p) || reUNC.MatchString(p) {
		return input
	}
	return P.Resolve(root, p)
}
