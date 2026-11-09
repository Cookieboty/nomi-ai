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
		// 主文件夹改了：空闲标签换到新的主文件夹
		roots["p1"] = []string{api, app}
		o.ProjectChanged("p1")
		if realDir(str(o.tab(id), "cwd")) != api {
			t.Fatalf("cwd after primary change = %s", str(o.tab(id), "cwd"))
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
