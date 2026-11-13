package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/ports"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 没有「本机登录」：内置编程助手只用 Nomi 管理的官方账号或经网关的第三方模型。

type fakeAccounts struct{ has map[string]bool }

func (f fakeAccounts) Launch(kind ports.AccountBackend, _ *string) ports.AccountLaunch {
	if !f.has[string(kind)] {
		panic(jsrt.JSThrow{Name: "Error", Message: "no official account"})
	}
	return ports.AccountLaunch{Env: util.NewObj("CLAUDE_CONFIG_DIR", "/acct"), Strip: []string{}, Args: []string{}, Sig: "official:a1"}
}
func (f fakeAccounts) HasAccount(kind ports.AccountBackend) bool { return f.has[string(kind)] }

func noLocalOrch(t *testing.T, root string, has map[string]bool) *Orchestrator {
	t.Helper()
	idle := 0.0
	tmp := filepath.Dir(root)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	return New(Deps{
		Root: root, Home: tmp, DefaultCwd: filepath.Join(tmp, "docs", "nomi"), LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle,
		Gateway: &effortGateway{}, Accounts: fakeAccounts{has: has},
	})
}

func TestLegacyLocalSignInTabsAreMigrated(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	root := filepath.Join(tmp, "harness")
	_ = os.MkdirAll(root, 0o755)
	cwd := filepath.Join(tmp, "work")
	_ = os.MkdirAll(cwd, 0o755)
	tabs := `{"tabs":[` +
		`{"id":"g1","backend":"gemini","source":"official","cwd":` + util.Stringify(cwd) + `,"title":"Gemini","cliSessionId":"gem-1","modelOverride":"gemini-2.5-pro"},` +
		`{"id":"c1","backend":"claude","source":"official","accountId":"local-claude","cwd":` + util.Stringify(cwd) + `,"title":"Claude Code"},` +
		`{"id":"c2","backend":"claude","source":"official","accountId":"a1","cwd":` + util.Stringify(cwd) + `,"title":"Claude Code 2"}` +
		`]}`
	if err := os.WriteFile(filepath.Join(root, "tabs.json"), []byte(tabs), 0o600); err != nil {
		t.Fatal(err)
	}
	o := noLocalOrch(t, root, map[string]bool{"claude": true})
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		g := o.tab("g1")
		if g.Get("source") != "thirdParty" || o.sourceOf(g) != "thirdParty" {
			t.Fatalf("gemini tab source=%v, want thirdParty (its official source was the local sign-in)", g.Get("source"))
		}
		if truthy(g.Get("cliSessionId")) || truthy(g.Get("modelOverride")) {
			t.Fatalf("gemini tab must start a new third-party session: %v", util.Stringify(g))
		}
		if c := o.tab("c1"); c.Has("accountId") || o.sourceOf(c) != "official" {
			t.Fatalf("claude tab on the local sign-in must follow the default official account: %v", util.Stringify(c))
		}
		if o.tab("c2").Get("accountId") != "a1" {
			t.Fatal("a pinned official account must stay")
		}
	})
}

func TestNoLocalSignInForNewTabs(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	o := noLocalOrch(t, filepath.Join(tmp, "harness"), map[string]bool{"claude": true})
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		// dsh / Gemini：没有官方账号能力，只有第三方来源
		for _, b := range []string{"gemini", "dsh"} {
			tab := o.CreateTab(util.NewObj("backend", b, "source", "official", "activate", false))
			if tab.Get("source") != "thirdParty" {
				t.Fatalf("%s new tab source=%v, want thirdParty", b, tab.Get("source"))
			}
			msg := func() (m string) {
				defer func() {
					if r := recover(); r != nil {
						m = r.(jsrt.JSThrow).Message
					}
				}()
				o.SetTabSource(str(tab, "id"), "official", nil)
				return ""
			}()
			if msg == "" {
				t.Fatalf("%s: switching to its own sign-in must be refused", b)
			}
			// 网关不在时也不退回 CLI 自己的登录
			func() {
				defer func() {
					if recover() == nil {
						t.Fatalf("%s: official launch must not fall back to the local sign-in", b)
					}
				}()
				o.officialLaunchFor(b, nil)
			}()
		}
		// 有官方账号的 Claude：新标签照旧用官方账号（网关这边默认是第三方模型时才用第三方）
		gw := o.d.Gateway
		o.d.Gateway = plainGateway{}
		if s := o.defaultSource("claude", ""); s != "official" {
			t.Fatalf("claude with an account: source=%s, want official", s)
		}
		// Codex 一个 Nomi 账号都没有、分配了第三方模型：新标签用第三方，不落到本机登录
		if s := o.defaultSource("codex", ""); s != "thirdParty" {
			t.Fatalf("codex without accounts: source=%s, want thirdParty", s)
		}
		o.d.Gateway = gw
	})
}
