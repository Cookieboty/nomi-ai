package desktop

import "strings"

// workspace.ts：对话工作区（cwd）作为隐式读写作用域

var homeContainers = []string{"Documents", "Desktop", "Downloads", "Library", "OneDrive", "Pictures"}

var posixSystem = []string{"/System", "/Library", "/Applications", "/Users", "/home", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/private", "/private/var", "/private/etc", "/tmp", "/private/tmp", "/Volumes", "/root"}

var winSystem = []string{"Windows", "Program Files", "Program Files (x86)", "ProgramData", "Users"}

// WorkspaceEnv 对应 WorkspaceEnv
type WorkspaceEnv struct {
	Home      string
	Platform  string
	Realpath  func(string) (string, error)
	DenyRoots []string
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
		if d := DenyReason(p, env.Platform, env.DenyRoots); d != "" {
			return WorkspaceCheck{Reason: "denied: " + d}
		}
		if IsBroadWorkspace(p, env.Home, env.Platform) {
			return WorkspaceCheck{Reason: "too broad"}
		}
	}
	return WorkspaceCheck{OK: true, Real: real}
}

// WorkspaceScope 工作区当作唯一作用域
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
