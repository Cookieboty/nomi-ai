package harness

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 标签只记 projectId：工作目录是主文件夹，其余文件夹每次启动时实时取（进 --add-dir / writableRoots / 沙箱）
func TestTabProjectExtraDirs(t *testing.T) {
	tmp := t.TempDir()
	mk := func(n string) string {
		p := filepath.Join(tmp, n)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		r, _ := filepath.EvalSymlinks(p)
		return r
	}
	app, api, docs := mk("app"), mk("api"), mk("docs")
	roots := map[string][]string{"p1": {app, api}}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: app, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle,
			ProjectRoots: func(id string) (string, []string) {
				r := roots[id]
				if len(r) == 0 {
					return "", nil
				}
				return r[0], r[1:]
			},
			InProject: func(dir string) bool { return dir == docs },
		})
		defer o.Dispose()
		tab := o.CreateTab(util.NewObj("backend", "claude", "projectId", "p1", "activate", false))
		id := util.Str(tab.Get("id"))
		if realDir(util.Str(tab.Get("cwd"))) != app || tab.Get("projectId") != "p1" {
			t.Fatalf("tab = %v", util.Stringify(tab))
		}
		if got := o.extraDirs(o.tab(id)); !slices.Equal(got, []string{api}) {
			t.Fatalf("extra = %v", got)
		}
		// 实时：项目加了文件夹，下次启动就带上
		roots["p1"] = []string{app, api, docs}
		if got := o.extraDirs(o.tab(id)); len(got) != 2 {
			t.Fatalf("extra after edit = %v", got)
		}
		s := o.buildSandboxSpec(o.tab(id), app, util.NewObj())
		if !slices.Contains(s.Writable, api) || !slices.Contains(s.Writable, docs) {
			t.Fatalf("sandbox writable = %v", s.Writable)
		}
		o.tab(id).Set("permissionMode", "plan")
		if s := o.buildSandboxSpec(o.tab(id), app, util.NewObj()); slices.Contains(s.Writable, api) {
			t.Fatal("plan mode keeps the other folders read-only too")
		}
		// 主文件夹改了，但工作目录还是项目里的文件夹：不动（不白开一个新会话）
		roots["p1"] = []string{api, app}
		o.ProjectChanged("p1")
		if realDir(str(o.tab(id), "cwd")) != app {
			t.Fatalf("cwd still inside the project moved to %s", str(o.tab(id), "cwd"))
		}
		// 工作目录被移出项目：换到新的主文件夹
		roots["p1"] = []string{api}
		o.ProjectChanged("p1")
		if realDir(str(o.tab(id), "cwd")) != api {
			t.Fatalf("cwd after leaving the project = %s", str(o.tab(id), "cwd"))
		}
		// 项目里的目录算已知目录（右栏 git / 文件浏览）
		if o.KnownDir(docs) == "" {
			t.Fatal("project folder should be known")
		}
		// 迁移：按目录补 projectId
		plain := o.CreateTab(util.NewObj("backend", "claude", "cwd", docs, "activate", false))
		pid := util.Str(plain.Get("id"))
		if !slices.Contains(o.TabCwds(), util.Str(plain.Get("cwd"))) {
			t.Fatal("TabCwds lists tabs without a project")
		}
		o.AdoptProjects(map[string]string{util.Str(plain.Get("cwd")): "p2"})
		if o.tab(pid).Get("projectId") != "p2" {
			t.Fatal("AdoptProjects")
		}
	})
}

// #309：运行中改了项目文件夹，不丢：这一轮结束后（或下一轮发出前）按最新的项目同步
func TestProjectChangedWhileRunningIsDeferred(t *testing.T) {
	tmp := t.TempDir()
	mk := func(n string) string {
		p := filepath.Join(tmp, n)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		r, _ := filepath.EvalSymlinks(p)
		return r
	}
	a, b, c := mk("a"), mk("b"), mk("c")
	roots := map[string][]string{"p1": {a}}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: a, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle,
			ProjectRoots: func(id string) (string, []string) {
				r := roots[id]
				if len(r) == 0 {
					return "", nil
				}
				return r[0], r[1:]
			},
		})
		defer o.Dispose()
		id := util.Str(o.CreateTab(util.NewObj("backend", "claude", "projectId", "p1", "activate", false)).Get("id"))
		o.tab(id).Set("status", "running")
		roots["p1"] = []string{b}
		o.ProjectChanged("p1")
		if realDir(str(o.tab(id), "cwd")) != a {
			t.Fatal("a running turn keeps its folder")
		}
		// 又改了一次：按最新的算
		roots["p1"] = []string{c}
		o.ProjectChanged("p1")
		o.applyPendingProject(id) // 还在跑：不动
		if realDir(str(o.tab(id), "cwd")) != a || !o.projectPending[id] {
			t.Fatal("still running: stay pending")
		}
		o.tab(id).Set("status", "idle")
		o.applyPendingProject(id)
		if realDir(str(o.tab(id), "cwd")) != c || o.projectPending[id] {
			t.Fatalf("next turn uses the latest project folder, cwd = %s", str(o.tab(id), "cwd"))
		}
	})
}

// 从本机历史打开的会话：工作目录在某个项目里就归进那个项目；项目主文件夹不能用时不归，会话照样打开
func TestOpenHistorySessionAdoptsProject(t *testing.T) {
	tmp := t.TempDir()
	app := filepath.Join(tmp, "app")
	if err := os.MkdirAll(filepath.Join(app, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	app, _ = filepath.EvalSymlinks(app)
	other := t.TempDir()
	roots := map[string]string{"p1": app}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: app, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle,
			ProjectRoots:  func(id string) (string, []string) { return roots[id], nil },
			ProjectFor: func(dir string) string {
				if dir == app || inside(dir, app) {
					return "p1"
				}
				return ""
			},
		})
		defer o.Dispose()
		open := func(session, cwd string) *util.Obj {
			r := o.OpenHistorySession(util.NewObj("backend", "codex", "sessionId", session, "cwd", cwd, "title", "t", "messages", []any{}))
			return r.Get("tab").(*util.Obj)
		}
		in := open("s1", filepath.Join(app, "src"))
		if in.Get("projectId") != "p1" || realDir(util.Str(in.Get("cwd"))) != filepath.Join(app, "src") {
			t.Fatalf("inside project: %v", util.Stringify(in))
		}
		if out := open("s2", other); out.Get("projectId") != nil {
			t.Fatalf("outside project: %v", util.Stringify(out))
		}
		delete(roots, "p1")
		if gone := open("s3", app); gone.Get("projectId") != nil {
			t.Fatalf("unavailable project: %v", util.Stringify(gone))
		}
	})
}

// 已有的、没归项目的标签：启动时 / 项目建好后，工作目录在项目里就补上；用户选了「不使用项目」的不动
func TestAdoptUnboundTabs(t *testing.T) {
	tmp := t.TempDir()
	app := filepath.Join(tmp, "app")
	if err := os.MkdirAll(filepath.Join(app, ".nomi-delegate", "w1"), 0o755); err != nil {
		t.Fatal(err)
	}
	app, _ = filepath.EvalSymlinks(app)
	worktree := filepath.Join(app, ".nomi-delegate", "w1")
	roots := map[string]string{}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: tmp, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle,
			ProjectRoots:  func(id string) (string, []string) { return roots[id], nil },
			ProjectFor: func(dir string) string {
				if roots["p1"] != "" && (dir == app || inside(realDir(dir), app)) {
					return "p1"
				}
				return ""
			},
		})
		defer o.Dispose()
		// 项目还没建：标签不归项目
		a := util.Str(o.CreateTab(util.NewObj("backend", "codex", "cwd", app, "activate", false)).Get("id"))
		w := util.Str(o.CreateTab(util.NewObj("backend", "codex", "cwd", worktree, "activate", false)).Get("id"))
		opt := util.Str(o.CreateTab(util.NewObj("backend", "codex", "cwd", app, "activate", false)).Get("id"))
		o.SetTabProject(opt, "", false)
		if o.tab(a).Get("projectId") != nil {
			t.Fatal("no project yet")
		}
		// 项目建好：已有标签补上；工作目录不动；「不使用项目」的不动
		roots["p1"] = app
		o.ProjectChanged("p1")
		if o.tab(a).Get("projectId") != "p1" || o.tab(w).Get("projectId") != "p1" {
			t.Fatalf("adopt: %v / %v", o.tab(a).Get("projectId"), o.tab(w).Get("projectId"))
		}
		if realDir(str(o.tab(w), "cwd")) != realDir(worktree) {
			t.Fatalf("worktree cwd moved to %s", str(o.tab(w), "cwd"))
		}
		if o.tab(opt).Get("projectId") != nil {
			t.Fatal("opted out tab was adopted")
		}
		// 新建的标签直接归项目
		if n := o.CreateTab(util.NewObj("backend", "codex", "cwd", worktree, "activate", false)); n.Get("projectId") != "p1" {
			t.Fatalf("new tab: %v", util.Stringify(n))
		}
	})
}
