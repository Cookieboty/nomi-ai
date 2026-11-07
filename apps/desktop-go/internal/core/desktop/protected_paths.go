package desktop

import (
	"slices"
	"strings"

	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

// 受保护的文件夹：用户在设置里加的黑名单，叠加在内置黑名单（path_guard.go）之上。
// Nomi 自己的文件工具（GuardPath）、对话工作区与编程助手标签的工作目录（CheckWorkspaceRoot）都认它。
// 存的是 realpath（选的是符号链接时，按链接目标保护），删除时按存的原样匹配。

// MaxProtectedPaths：受保护文件夹的上限
const MaxProtectedPaths = 100

func loadProtectedPaths(raw []any) []string {
	out := []string{}
	for _, x := range raw {
		if s, ok := x.(string); ok && s != "" && !slices.Contains(out, s) && len(out) < MaxProtectedPaths {
			out = append(out, s)
		}
	}
	return out
}

// ProtectedPaths：用户加的受保护文件夹（按加入先后）
func (b *PermissionBroker) ProtectedPaths() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.settings.ProtectedPaths...)
}

// AddProtectedPath：加一个受保护文件夹；返回存下的路径，或不能加的原因（根目录、主目录、超过上限、路径不合法）
func (b *PermissionBroker) AddProtectedPath(p string) (string, string) {
	norm, bad := NormalizeInput(p, b.envBase.Home, b.envBase.Platform)
	if bad != nil {
		return "", bad.Message
	}
	P := lib(b.envBase.Platform)
	if P.Dirname(norm) == norm || (b.envBase.Home != "" && samePath(norm, b.envBase.Home, b.envBase.Platform)) {
		return "", tr.T("electron.common.protected-path-too-broad")
	}
	rp := b.envBase.Realpath
	if rp == nil {
		rp = RealpathNative
	}
	if real, err := rp(norm); err == nil {
		norm = real
	}
	b.mu.Lock()
	list := b.settings.ProtectedPaths
	if slices.ContainsFunc(list, func(x string) bool { return samePath(x, norm, b.envBase.Platform) }) {
		b.mu.Unlock()
		return norm, ""
	}
	if len(list) >= MaxProtectedPaths {
		b.mu.Unlock()
		return "", tr.T("electron.common.protected-path-limit", MaxProtectedPaths)
	}
	b.settings.ProtectedPaths = append(list, norm)
	b.saveLocked()
	b.mu.Unlock()
	b.notify()
	return norm, ""
}

// RemoveProtectedPath：删掉一个受保护文件夹
func (b *PermissionBroker) RemoveProtectedPath(p string) bool {
	b.mu.Lock()
	before := len(b.settings.ProtectedPaths)
	b.settings.ProtectedPaths = slices.DeleteFunc(b.settings.ProtectedPaths, func(x string) bool { return x == p })
	changed := len(b.settings.ProtectedPaths) != before
	if changed {
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
	return changed
}

func (b *PermissionBroker) workspaceEnv() WorkspaceEnv {
	return WorkspaceEnv{Home: b.envBase.Home, Platform: b.envBase.Platform, Realpath: b.envBase.Realpath,
		DenyRoots: b.envBase.DenyRoots, UserDeny: b.ProtectedPaths()}
}

// CheckCliWorkspace：编程助手标签的工作目录能不能用（与 Nomi 对话工作区同一套规则：
// 不能是根目录 / 主目录 / 系统目录 / 主目录下的大容器，不能在内置或用户的受保护文件夹里）。
// 不能用时返回给用户看的原因。
func (b *PermissionBroker) CheckCliWorkspace(dir string) string {
	r := CheckWorkspaceRoot(dir, b.workspaceEnv())
	if r.OK {
		return ""
	}
	return WorkspaceReasonText(r.Reason)
}

// WorkspaceReasonText：CheckWorkspaceRoot 的原因 → 界面文案
func WorkspaceReasonText(reason string) string {
	if d, ok := strings.CutPrefix(reason, "denied: "); ok {
		return d
	}
	switch reason {
	case "too broad":
		return tr.T("electron.common.workspace-too-broad")
	case "missing", "not absolute":
		return tr.T("electron.common.invalid-working-directory")
	}
	return reason
}

// MaxCliEnvAllow：放行变量名的上限
const MaxCliEnvAllow = 50

// normalizeEnvNames：只留合法的变量名，去重（按大写比较），限量
func normalizeEnvNames(raw []any) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, x := range raw {
		s, ok := x.(string)
		if !ok {
			continue
		}
		s = strings.TrimSpace(s)
		if !validEnvName(s) || seen[strings.ToUpper(s)] || len(out) >= MaxCliEnvAllow {
			continue
		}
		seen[strings.ToUpper(s)] = true
		out = append(out, s)
	}
	return out
}

func validEnvName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	for i, r := range name {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9') {
			continue
		}
		return false
	}
	return true
}

// CliEnvAllow：放行给编程助手的环境变量名
func (b *PermissionBroker) CliEnvAllow() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.settings.CliEnvAllow...)
}

// SetCliEnvAllow：整体替换放行清单（不合法的名字丢掉）
func (b *PermissionBroker) SetCliEnvAllow(names []any) {
	next := normalizeEnvNames(names)
	b.mu.Lock()
	changed := !slices.Equal(next, b.settings.CliEnvAllow)
	if changed {
		b.settings.CliEnvAllow = next
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
}

// SandboxAllow：编程助手沙箱里「始终允许」的一项（Kind：category / read / folder / file）。
// Project：只在这个项目里生效（读凭据 / 密钥文件按项目记）；空 = 所有项目
type SandboxAllow struct {
	Kind    string `json:"kind"`
	Value   string `json:"value"`
	Project string `json:"project,omitempty"`
}

// MaxSandboxAllow：「始终允许」的上限
const MaxSandboxAllow = 100

func normalizeSandboxAllow(raw []SandboxAllow) []SandboxAllow {
	out := []SandboxAllow{}
	for _, a := range raw {
		if (a.Kind != "category" && a.Kind != "read" && a.Kind != "folder" && a.Kind != "file") || a.Value == "" ||
			slices.Contains(out, a) || len(out) >= MaxSandboxAllow {
			continue
		}
		out = append(out, a)
	}
	return out
}

// CliSandboxEnabled：编程助手的系统沙箱开着（缺省开）
func (b *PermissionBroker) CliSandboxEnabled() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.settings.CliSandboxOff
}

// SetCliSandboxEnabled：开关编程助手的系统沙箱
func (b *PermissionBroker) SetCliSandboxEnabled(on bool) {
	b.mu.Lock()
	changed := b.settings.CliSandboxOff == on
	if changed {
		b.settings.CliSandboxOff = !on
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
}

// CliSandboxAllow：「始终允许」的授权
func (b *PermissionBroker) CliSandboxAllow() []SandboxAllow {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]SandboxAllow{}, b.settings.CliSandboxAllow...)
}

// AddCliSandboxAllow：记一条「始终允许」（已有的不重复）
func (b *PermissionBroker) AddCliSandboxAllow(a SandboxAllow) {
	next := normalizeSandboxAllow(append(b.CliSandboxAllow(), a))
	b.mu.Lock()
	changed := !slices.Equal(next, b.settings.CliSandboxAllow)
	if changed {
		b.settings.CliSandboxAllow = next
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
}

// RemoveCliSandboxAllow：删掉一条「始终允许」
func (b *PermissionBroker) RemoveCliSandboxAllow(a SandboxAllow) bool {
	b.mu.Lock()
	before := len(b.settings.CliSandboxAllow)
	b.settings.CliSandboxAllow = slices.DeleteFunc(b.settings.CliSandboxAllow, func(x SandboxAllow) bool { return x == a })
	changed := len(b.settings.CliSandboxAllow) != before
	if changed {
		b.saveLocked()
	}
	b.mu.Unlock()
	if changed {
		b.notify()
	}
	return changed
}
