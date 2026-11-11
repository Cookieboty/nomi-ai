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

// withinAny：dir 是 roots 之一或在其中某个里面（按 realpath 比）
func withinAny(dir string, roots []string) bool {
	real := realDir(dir)
	for _, r := range roots {
		if r == "" {
			continue
		}
		if winKey(real) == winKey(r) || inside(real, r) {
			return true
		}
	}
	return false
}

// inside：child 在 parent 里（不含相等）
func inside(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// SetTabProject：把标签换到另一个项目（工作目录换成它的主文件夹，像换目录一样开新会话；carry = 带上前文）。
// projectId 为空 = 不用项目（目录不变；活着的 CLI 进程断开，下一轮不再带旧项目的其余文件夹）
func (o *Orchestrator) SetTabProject(id, projectID string, carry bool) *util.Obj {
	tab := o.requireTab(id)
	if projectID == "" {
		tab.Delete("projectId")
		// 用户选了「不使用项目」：之后不再按工作目录自动归回项目（AdoptUnboundTabs）
		tab.Set(projectOptOutKey, true)
		o.changed()
		o.syncOrDefer(id)
		return tab.Clone()
	}
	primary, _ := o.projectRoots(projectID)
	if primary == "" {
		throw(i18n.T("electron.common.invalid-working-directory"))
	}
	tab.Set("projectId", projectID)
	tab.Delete(projectOptOutKey)
	return o.SetTabCwd(id, primary, carry)
}

// ProjectChanged：项目的文件夹变了（或项目被删了）。空闲标签马上同步；正在跑的标签记下，
// 这一轮结束后（或下一轮发出前）再同步，下一轮按最新的文件夹工作（#309）
func (o *Orchestrator) ProjectChanged(projectID string) {
	// 新建 / 改了项目：工作目录落在里面、还没归项目的标签先归进来（再按下面同步）
	o.AdoptUnboundTabs()
	for _, k := range o.tabs.Keys() {
		if k == MainTabID || str(o.tab(k), "projectId") != projectID {
			continue
		}
		o.syncOrDefer(k)
	}
}

func (o *Orchestrator) syncOrDefer(id string) {
	if o.tab(id).Get("status") == "running" {
		o.projectPending[id] = true
		return
	}
	delete(o.projectPending, id)
	o.syncTabProject(id)
}

// applyPendingProject：标签空闲了，补上运行期间记下的项目变化（多次变化按最新的项目算）
func (o *Orchestrator) applyPendingProject(id string) {
	if !o.projectPending[id] {
		return
	}
	tab := o.tab(id)
	if tab == nil {
		delete(o.projectPending, id)
		return
	}
	if tab.Get("status") == "running" {
		return
	}
	delete(o.projectPending, id)
	o.syncTabProject(id)
}

// syncTabProject：按项目此刻的文件夹同步一个空闲标签：工作目录已经不在项目的任何文件夹里了（主文件夹换了），
// 工作目录跟着换到新的主文件夹（开新会话、带上前文）；还在里面的（主文件夹本身、子目录、其余文件夹）不动。
// 否则断开活着的 CLI 进程（--add-dir / 沙箱可写目录只在启动时给），下一轮按新的文件夹重新启动（接着原会话）。
// 项目不在了（或标签不再用项目）也断开，不让旧进程留着旧文件夹的授权
func (o *Orchestrator) syncTabProject(k string) {
	tab := o.tab(k)
	if tab == nil {
		return
	}
	primary, extra := o.projectRoots(str(tab, "projectId"))
	if primary != "" && tab.Get("delegation") == nil && !withinAny(str(tab, "cwd"), append([]string{primary}, extra...)) {
		o.SetTabCwd(k, primary, true)
		return
	}
	o.teardownClaudeLive(k)
	o.teardownCodexLive(k)
	o.teardownAcpLive(k)
}

// TabCwds：编程助手标签（不含主标签与委派开的）的工作目录，首启迁移建项目用
func (o *Orchestrator) TabCwds() []string {
	out := []string{}
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || tab.Get("delegation") != nil || str(tab, "projectId") != "" || truthy(tab.Get(projectOptOutKey)) {
			continue
		}
		if c := str(tab, "cwd"); c != "" {
			out = append(out, c)
		}
	}
	return out
}

// projectOptOutKey：标签上的标记——用户明确选了「不使用项目」，不再自动归项目
const projectOptOutKey = "projectOptOut"

// AdoptUnboundTabs：还没归项目的标签，工作目录落在某个已有项目里（嵌套取最具体的）就归进去。
// 启动时与项目新建 / 修改时跑：以前打开的历史会话、委派开的 worktree 标签、项目建得比标签晚的都能补上。
// 用户明确不要项目的（projectOptOut）不动；项目主文件夹此刻不能用时不归
func (o *Orchestrator) AdoptUnboundTabs() {
	if o.d.ProjectFor == nil {
		return
	}
	n := 0
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || tab == nil || str(tab, "projectId") != "" || truthy(tab.Get(projectOptOutKey)) {
			continue
		}
		cwd := str(tab, "cwd")
		if cwd == "" {
			continue
		}
		if pid := o.d.ProjectFor(cwd); pid != "" {
			if primary, _ := o.projectRoots(pid); primary != "" {
				tab.Set("projectId", pid)
				n++
			}
		}
	}
	if n > 0 {
		o.changed()
	}
}

// AdoptProjects：迁移：按 目录 → 项目 id 给还没有项目的标签补上 projectId（用户选了不使用项目的不动）
func (o *Orchestrator) AdoptProjects(byDir map[string]string) {
	n := 0
	for _, k := range o.tabs.Keys() {
		tab := o.tab(k)
		if k == MainTabID || tab.Get("delegation") != nil || str(tab, "projectId") != "" || truthy(tab.Get(projectOptOutKey)) {
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
