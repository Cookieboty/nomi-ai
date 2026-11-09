package harness

// 标签的项目：标签只记 projectId（持久化在 tabs.json 的标签对象里），工作目录是项目的主文件夹
// （委派开的 worktree 标签例外：工作目录是 worktree，其余文件夹照样带上）。其余文件夹每次启动 CLI 时实时取：
// Claude / Codex 用 --add-dir，Codex app-server 用 sandboxPolicy.writableRoots，ACP 用 additionalDirectories，
// Gemini 用 --include-directories；不支持的 CLI 只在主文件夹里做。

import (
	"path/filepath"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// projectRoots：项目此刻的目录；没有 ProjectRoots 依赖或项目不在时 primary 为空
func (o *Orchestrator) projectRoots(id string) (string, []string) {
	if id == "" || o.d.ProjectRoots == nil {
		return "", nil
	}
	return o.d.ProjectRoots(id)
}

// extraDirs：标签这次启动要额外带上的目录（项目里除工作目录之外的文件夹；与工作目录相同或在它里面的去掉）
func (o *Orchestrator) extraDirs(tab *util.Obj) []string {
	pid := str(tab, "projectId")
	if pid == "" {
		return nil
	}
	primary, extra := o.projectRoots(pid)
	if primary == "" {
		return nil
	}
	cwd := realDir(str(tab, "cwd"))
	out := []string{}
	for _, d := range append([]string{primary}, extra...) {
		if d == "" || winKey(d) == winKey(cwd) || inside(cwd, d) {
			continue
		}
		out = append(out, d)
	}
	return out
}

// inside：child 在 parent 里（不含相等）
func inside(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// SetTabProject：把标签换到另一个项目（工作目录换成它的主文件夹，像换目录一样开新会话；carry = 带上前文）。
// projectId 为空 = 不用项目（目录不变）
func (o *Orchestrator) SetTabProject(id, projectID string, carry bool) *util.Obj {
	tab := o.requireTab(id)
	if projectID == "" {
		tab.Delete("projectId")
		o.changed()
		return tab.Clone()
	}
	primary, _ := o.projectRoots(projectID)
	if primary == "" {
		throw(i18n.T("electron.common.invalid-working-directory"))
	}
	tab.Set("projectId", projectID)
	return o.SetTabCwd(id, primary, carry)
}

// ProjectChanged：项目的文件夹变了。用它的空闲标签断开活着的 CLI 进程，下一轮按新的文件夹重新启动（接着原会话）；
// 主文件夹变了的，工作目录跟着换（开新会话、带上前文）
func (o *Orchestrator) ProjectChanged(projectID string) {
	primary, _ := o.projectRoots(projectID)
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || str(tab, "projectId") != projectID || tab.Get("status") == "running" {
			continue
		}
		if primary == "" {
			continue
		}
		if tab.Get("delegation") == nil && winKey(str(tab, "cwd")) != winKey(primary) {
			o.SetTabCwd(k, primary, true)
			continue
		}
		o.teardownClaudeLive(k)
		o.teardownCodexLive(k)
		o.teardownAcpLive(k)
	}
}

// TabCwds：编程助手标签（不含主标签与委派开的）的工作目录，首启迁移建项目用
func (o *Orchestrator) TabCwds() []string {
	out := []string{}
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || tab.Get("delegation") != nil || str(tab, "projectId") != "" {
			continue
		}
		if c := str(tab, "cwd"); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// AdoptProjects：首启迁移：按 目录 → 项目 id 给还没有项目的标签补上 projectId
func (o *Orchestrator) AdoptProjects(byDir map[string]string) {
	n := 0
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || tab.Get("delegation") != nil || str(tab, "projectId") != "" {
			continue
		}
		if id := byDir[str(tab, "cwd")]; id != "" {
			tab.Set("projectId", id)
			n++
		}
	}
	if n > 0 {
		o.changed()
	}
}
