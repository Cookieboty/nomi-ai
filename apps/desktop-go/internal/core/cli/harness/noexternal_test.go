package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 不再支持用户添加的「外部 CLI」：旧标签启动时关掉，也不能再新建或切换过去。

func TestLegacyExternalCliTabsAreDropped(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	tabsDir := filepath.Join(root, "tabs")
	_ = os.MkdirAll(tabsDir, 0o755)
	cwd := filepath.Join(tmp, "work")
	_ = os.MkdirAll(cwd, 0o755)
	tabs := `{"activeTabId":"x1","tabs":[` +
		`{"id":"x1","backend":"external","pluginId":"my-agent","cwd":` + util.Stringify(cwd) + `,"title":"My Agent"},` +
		`{"id":"x2","backend":"external","cwd":` + util.Stringify(cwd) + `,"title":"Broken"},` +
		`{"id":"c1","backend":"claude","source":"official","accountId":"a1","cwd":` + util.Stringify(cwd) + `,"title":"Claude Code"}` +
		`]}`
	if err := os.WriteFile(filepath.Join(root, "tabs.json"), []byte(tabs), 0o600); err != nil {
		t.Fatal(err)
	}
	msgs := filepath.Join(tabsDir, tabFileName("x1")+".json")
	carry := filepath.Join(tabsDir, tabFileName("x1")+".carry.txt")
	_ = os.WriteFile(msgs, []byte(`[{"role":"user","content":"hi"}]`), 0o600)
	_ = os.WriteFile(carry, []byte("old"), 0o600)
	o := noLocalOrch(t, root, map[string]bool{"claude": true})
	jsrt.Run(func() {
		if o.tab("x1") != nil || o.tab("x2") != nil {
			t.Fatal("external CLI tabs must not be restored")
		}
		if o.tab("c1") == nil {
			t.Fatal("built-in tabs must stay")
		}
		if o.activeTabID == "x1" {
			t.Fatal("the active tab must not point at a dropped external CLI tab")
		}
		for _, x := range o.ListTabs().Get("tabs").([]any) {
			if util.AsObj(x).Get("backend") == "external" {
				t.Fatalf("listed an external CLI tab: %v", util.Stringify(x))
			}
		}
	})
	jsrt.Run(o.Dispose)
	for _, p := range []string{msgs, carry} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s must be removed with the dropped tab (err=%v)", filepath.Base(p), err)
		}
	}
	b, err := os.ReadFile(filepath.Join(root, "tabs.json"))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := util.Parse(b)
	for _, x := range util.AsObj(v).Get("tabs").([]any) {
		if util.AsObj(x).Get("backend") == "external" {
			t.Fatalf("tabs.json still has an external CLI tab: %s", b)
		}
	}
}

func TestExternalCliBackendIsRejected(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	o := noLocalOrch(t, filepath.Join(tmp, "harness"), map[string]bool{"claude": true})
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		throws := func(name string, f func()) {
			defer func() {
				if recover() == nil {
					t.Fatalf("%s: must be refused", name)
				}
			}()
			f()
		}
		throws("create", func() { o.CreateTab(util.NewObj("backend", "external", "pluginId", "my-agent", "activate", false)) })
		tab := o.CreateTab(util.NewObj("backend", "claude", "activate", false))
		throws("switch", func() { o.SetTabBackend(str(tab, "id"), "external") })
		if isBackend("external") {
			t.Fatal("external must not be a backend")
		}
	})
}
