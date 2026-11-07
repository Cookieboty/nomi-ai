package harness

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/sandbox"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func pendingOf(o *Orchestrator, id string) []*util.Obj {
	for _, x := range o.ListTabs().Get("tabs").([]any) {
		t := x.(*util.Obj)
		if t.Get("id") == id {
			if p, ok := t.Get("sandboxPending").([]any); ok {
				out := []*util.Obj{}
				for _, e := range p {
					out = append(out, e.(*util.Obj))
				}
				return out
			}
		}
	}
	return nil
}

// 违规 → 标签上的授权请求；本会话允许 / 始终允许 / 不允许；受保护文件夹不能在这里授权
func TestSandboxRequests(t *testing.T) {
	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	var persisted []SandboxGrant
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: "/Users/me", DefaultCwd: proj, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{
				Enabled: func() bool { return true },
				Always:  func() []SandboxGrant { return persisted },
				Persist: func(g SandboxGrant) { persisted = append(persisted, g) },
			}})
		defer o.Dispose()
		tab := o.CreateTab(util.NewObj("backend", "claude", "cwd", proj, "activate", false))
		id := util.Str(tab.Get("id"))
		o.sbx.tokens = map[string]string{"tok": id}

		deny := func(rule, path string) {
			o.onSandboxDeny(sandbox.Denial{Token: "tok", Rule: rule, Op: "file-read-data", Path: path, Proc: "cat"})
		}
		deny("read:ssh", "/Users/me/.ssh/config")
		deny("read:ssh", "/Users/me/.ssh/id_ed25519") // 同一类只挂一次
		deny("write", "/Users/me/.ai-usage/logs/a.log")
		deny("read:protected", "/Users/me/finance/a.pdf")
		deny("read:nomi", "/Users/me/Library/Application Support/nomi/chat/x.json") // 不让授权，不挂
		o.onSandboxDeny(sandbox.Denial{Token: "unknown", Rule: "read:ssh", Path: "/x"})
		p := pendingOf(o, id)
		if len(p) != 3 {
			t.Fatalf("pending = %v", util.Stringify(p))
		}
		if p[0].Get("kind") != "category" || p[0].Get("value") != "ssh" || p[1].Get("kind") != "folder" ||
			p[1].Get("value") != "/Users/me/.ai-usage" || p[1].Get("op") != "write" || p[2].Get("kind") != "protected" {
			t.Fatalf("pending = %v", util.Stringify(p))
		}

		if o.SandboxReply(id, util.Str(p[2].Get("id")), "session") {
			t.Fatal("protected folders can't be granted from a chat")
		}
		if !o.SandboxReply(id, util.Str(p[0].Get("id")), "session") {
			t.Fatal("session grant")
		}
		if !o.SandboxReply(id, util.Str(p[1].Get("id")), "always") || len(persisted) != 1 ||
			persisted[0] != (SandboxGrant{"folder", "/Users/me/.ai-usage"}) {
			t.Fatalf("always grant persisted = %v", persisted)
		}
		if !o.SandboxReply(id, util.Str(p[2].Get("id")), "deny") {
			t.Fatal("deny")
		}
		if got := pendingOf(o, id); len(got) != 0 {
			t.Fatalf("all answered, got %v", util.Stringify(got))
		}
		// 授权过 / 拒绝过的不再问（旧进程迟到的违规也一样）
		deny("read:ssh", "/Users/me/.ssh/config")
		deny("write", "/Users/me/.ai-usage/x")
		deny("read:protected", "/Users/me/finance/a.pdf")
		if got := pendingOf(o, id); len(got) != 0 {
			t.Fatalf("answered items must not come back, got %v", util.Stringify(got))
		}
		// 授权进下一次启动的配置
		got := map[string]bool{}
		for _, g := range o.grantedFor(id) {
			got[g.Kind+":"+g.Value] = true
		}
		if !got["category:ssh"] || !got["folder:/Users/me/.ai-usage"] {
			t.Fatalf("grantedFor = %v", got)
		}
		o.CloseTab(id)
		if o.sbx.tabs[id] != nil || o.sbx.tokens["tok"] != "" {
			t.Fatal("closing the tab forgets its grants")
		}
	})
}

// 沙箱配置：计划模式项目只读、CLI 的账号目录可写、授权的类别与文件夹进配置
func TestSandboxSpec(t *testing.T) {
	if !sandbox.Supported() {
		t.Skip("sandbox not supported here")
	}
	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	on := true
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: proj, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{
				Enabled:   func() bool { return on },
				Protected: func() []string { return []string{filepath.Join(tmp, "finance")} },
				Always:    func() []SandboxGrant { return []SandboxGrant{{"file", filepath.Join(tmp, ".zshrc")}} },
			}})
		defer o.Dispose()
		tab := o.CreateTab(util.NewObj("backend", "claude", "cwd", proj, "activate", false))
		id := util.Str(tab.Get("id"))
		o.sbxTab(id).granted["category:cloud"] = true
		env := util.NewObj("CLAUDE_CONFIG_DIR", filepath.Join(tmp, "acct"))
		s := o.sandboxSpec(o.tab(id), proj, env)
		if s == nil || !s.CwdWritable || !s.Granted["cloud"] || len(s.Protected) != 1 ||
			len(s.WritableFiles) != 1 || len(s.Writable) != 1 || s.Writable[0] != filepath.Join(tmp, "acct") {
			t.Fatalf("spec = %+v", s)
		}
		if o.sbx.tokens[s.Token] != id {
			t.Fatal("token maps back to the tab")
		}
		o.tab(id).Set("permissionMode", "plan")
		if s := o.sandboxSpec(o.tab(id), proj, env); s.CwdWritable {
			t.Fatal("plan mode keeps the project read-only")
		}
		if len(o.claudeSandboxArgs()) == 0 || o.SandboxStatus() != "on" {
			t.Fatal("Claude's own sandbox is switched off inside ours")
		}
		on = false
		if o.sandboxSpec(o.tab(id), proj, env) != nil || o.SandboxStatus() != "off" || o.claudeSandboxArgs() != nil {
			t.Fatal("switched off: no wrapping")
		}
	})
}

// 沙箱开着时真起（假的）CLI：Claude 常驻进程、Codex app-server、Grok 每轮一个进程都能在 sandbox-exec 里跑完一轮
func TestSandboxedTurns(t *testing.T) {
	if !sandbox.Supported() {
		t.Skip("sandbox not supported here")
	}
	o := titleTestOrch(t)
	o.d.Sandbox = &SandboxDeps{Enabled: func() bool { return true }}
	defer jsrt.Run(o.Dispose)
	for _, backend := range []string{"claude", "codex", "grok"} {
		tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", backend)) })
		id := str(tab, "id")
		awaitSend(t, o, id, "hello from the sandbox")
		toks := jsrt.Call(func() int {
			n := 0
			for _, tab := range o.sbx.tokens {
				if tab == id {
					n++
				}
			}
			return n
		})
		if toks == 0 {
			t.Fatalf("%s: the turn did not go through the sandbox", backend)
		}
	}
}

// 真的违规：沙箱里读 ~/.ssh → 系统日志 → 标签上出现「SSH 与 Git 凭据」的授权请求
func TestSandboxDenialReachesTab(t *testing.T) {
	if !sandbox.Supported() {
		t.Skip("sandbox not supported here")
	}
	// 数据目录与主目录分开（真实应用里数据目录在 ~/Library/Application Support 下，不是主目录的上级）
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(tmp, "home")
	work := filepath.Join(home, "work")
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{Root: filepath.Join(tmp, "userdata", "harness"), Home: home, DefaultCwd: work, Logger: nopLogger{},
		Ports: nopPorts{}, IdleReclaimMs: &idle, Sandbox: &SandboxDeps{Enabled: func() bool { return true }}})
	defer jsrt.Run(o.Dispose)
	secret := filepath.Join(home, ".ssh", "id_test")
	if err := os.MkdirAll(filepath.Dir(secret), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret, []byte("k"), 0o600); err != nil {
		t.Fatal(err)
	}
	tab := jsrt.Call(func() *util.Obj { return o.CreateTab(util.NewObj("backend", "claude")) })
	id := str(tab, "id")
	// 监听先起来（log stream 启动要一点时间），再触发违规；违规可能早于监听就绪，重试几次
	jsrt.Run(o.ensureSandboxMonitor)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		jsrt.Run(func() {
			ch := o.spawnCLI(o.tab(id), "/bin/cat", []string{secret}, str(o.tab(id), "cwd"), util.NewObj("PATH", "/usr/bin:/bin"))
			_ = ch
		})
		time.Sleep(700 * time.Millisecond)
		if p := jsrt.Call(func() []*util.Obj { return pendingOf(o, id) }); len(p) > 0 {
			if p[0].Get("kind") != "category" || p[0].Get("value") != "ssh" {
				t.Fatalf("pending = %v", util.Stringify(p))
			}
			return
		}
	}
	t.Fatal("the denial never reached the tab")
}
