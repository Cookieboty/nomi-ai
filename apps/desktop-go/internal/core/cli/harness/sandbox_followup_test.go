package harness

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/sandbox"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 授权后的「已允许，请继续」只发给挡下它、而且还在跑的那一轮，且只发一次：
// 新会话里 CLI 启动时读钥匙串、轮次结束后才授权、轮次被停掉，都不替用户发消息
func TestSandboxGrantFollowUpOnlyForLiveTurn(t *testing.T) {
	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: "/Users/me", DefaultCwd: proj, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{Enabled: func() bool { return true }}})
		defer o.Dispose()
		tab := o.CreateTab(util.NewObj("backend", "claude", "cwd", proj, "activate", false))
		id := util.Str(tab.Get("id"))
		o.sbx.tokens = map[string]string{"tok": id}
		deny := func(path string) string {
			o.onSandboxDeny(sandbox.Denial{Token: "tok", Rule: "write", Op: "file-write-create", Path: path, Proc: "claude"})
			p := pendingOf(o, id)
			if len(p) == 0 {
				t.Fatalf("no pending request for %s", path)
			}
			return util.Str(p[len(p)-1].Get("id"))
		}
		grant := func(req string) {
			if !o.SandboxReply(id, req, "session") {
				t.Fatalf("grant %s failed", req)
			}
		}
		follow := func() string { return o.sbx.tabs[id].followUp }
		msgs := func() int { return len(o.TabMessages(id)) }
		before := msgs()

		// 1. 新会话、还没发过消息：CLI 启动时自己读钥匙串被挡 → 授权只放开沙箱，不发消息
		grant(deny("/Users/me/Library/Keychains/x.db"))
		if follow() != "" || o.nextOrigin[id] != "" {
			t.Fatalf("idle grant must not queue a follow-up: %q", follow())
		}

		// 2. 这一轮里被挡、这一轮还在跑时授权 → 这一轮结束后补发一次
		o.beginTurnSandbox(id)
		grant(deny("/Users/me/w2/a.txt"))
		if follow() == "" {
			t.Fatal("a grant during the blocked turn should queue the follow-up")
		}
		// 这一轮被用户停掉：不发，也不留到下一轮
		o.afterTurnSandbox(id, true)
		if follow() != "" {
			t.Fatal("a stopped turn drops the follow-up")
		}

		// 3. 这一轮里被挡，但轮次结束后才授权 → 不发
		o.beginTurnSandbox(id)
		late := deny("/Users/me/w3/b.png")
		o.afterTurnSandbox(id, false)
		grant(late)
		if follow() != "" {
			t.Fatal("granting after the turn ended must not send a follow-up")
		}

		// 4. 上一轮挡下的请求，到下一轮（或新会话的第一轮）才授权 → 不发
		o.beginTurnSandbox(id)
		old := deny("/Users/me/w4/c.mp3")
		o.afterTurnSandbox(id, false)
		o.beginTurnSandbox(id)
		grant(old)
		if follow() != "" {
			t.Fatal("a request from an earlier turn must not send into the next one")
		}
		o.afterTurnSandbox(id, false)
		if msgs() != before {
			t.Fatalf("no message should have been sent, got %d → %d", before, msgs())
		}
	})
}
