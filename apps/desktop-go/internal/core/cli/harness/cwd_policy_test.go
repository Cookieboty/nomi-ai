package harness

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func throws(f func()) (msg string) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(jsrt.JSThrow); ok {
				msg = e.Message
				return
			}
			panic(r)
		}
	}()
	f()
	return ""
}

// 工作目录策略（Deps.CwdCheck）：新建标签、换目录、起 CLI 前都查，不认就带原因报错
func TestCwdPolicy(t *testing.T) {
	tmp := t.TempDir()
	ok := filepath.Join(tmp, "proj")
	blocked := filepath.Join(tmp, "blocked")
	for _, d := range []string{ok, blocked} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: ok, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, CwdCheck: func(dir string) string {
				if strings.HasPrefix(dir, blocked) {
					return "protected"
				}
				return ""
			}})
		defer o.Dispose()

		if msg := throws(func() { o.CreateTab(util.NewObj("backend", "claude", "cwd", blocked, "activate", false)) }); !strings.Contains(msg, "protected") {
			t.Fatalf("CreateTab in a blocked folder must fail with the reason, got %q", msg)
		}
		tab := o.CreateTab(util.NewObj("backend", "claude", "cwd", ok, "activate", false))
		id := util.Str(tab.Get("id"))
		if msg := throws(func() { o.SetTabCwd(id, blocked, false) }); !strings.Contains(msg, "protected") {
			t.Fatalf("SetTabCwd to a blocked folder must fail, got %q", msg)
		}
		if got := util.Str(o.tab(id).Get("cwd")); got != ok {
			t.Fatalf("cwd must stay %q, got %q", ok, got)
		}
		// 设置改了之后已有标签的目录不再可用：起 CLI 前拦下
		if o.cwdErr(ok) != nil || o.cwdErr(blocked) == nil {
			t.Fatal("cwdErr must follow the policy")
		}
	})
}
