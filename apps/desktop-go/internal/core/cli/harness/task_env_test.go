package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 持续任务的标签：审批等 7 天；默认隔离 gh 登录，授权里有 GitHub 对外能力时不隔离（同 HarnessDelegation.test.ts）
func TestTaskTabEnv(t *testing.T) {
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"),
			LegacyDefaultCwd: filepath.Join(tmp, "docs"), Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
		defer o.Dispose()
		mk := func(del *util.Obj) *util.Obj {
			opts := util.NewObj("backend", "codex", "activate", false)
			if del != nil {
				opts.Set("delegation", del)
			}
			return o.CreateTab(opts)
		}
		task := mk(util.NewObj("goal", "x", "taskId", "task_1"))
		open := mk(util.NewObj("goal", "x", "taskId", "task_2", "githubAccess", true))
		plain := mk(nil)
		if o.PermissionTimeoutMs(util.Str(task.Get("id"))) != TaskPermissionTimeoutMs {
			t.Fatal("timeout")
		}
		env := util.NewObj("PATH", "/bin", "GH_TOKEN", "t", "GITHUB_TOKEN", "g", "GH_ENTERPRISE_TOKEN", "e")
		got := o.taskEnv(o.tab(util.Str(task.Get("id"))), env)
		if got.Get("PATH") != "/bin" || got.Get("GH_PROMPT_DISABLED") != "1" || got.Has("GH_TOKEN") ||
			got.Has("GITHUB_TOKEN") || got.Has("GH_ENTERPRISE_TOKEN") {
			t.Fatal(util.Stringify(got))
		}
		if ents, err := os.ReadDir(util.Str(got.Get("GH_CONFIG_DIR"))); err != nil || len(ents) != 0 {
			t.Fatal(err, ents)
		}
		if o.taskEnv(o.tab(util.Str(open.Get("id"))), env) != env || o.taskEnv(o.tab(util.Str(plain.Get("id"))), env) != env {
			t.Fatal("non-isolated tabs must keep env")
		}
	})
}
