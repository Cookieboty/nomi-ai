package harness

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
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
			p[1].Get("value") != filepath.FromSlash("/Users/me/.ai-usage/logs") || p[1].Get("op") != "write" || p[2].Get("kind") != "protected" {
			t.Fatalf("pending = %v", util.Stringify(p))
		}

		if o.SandboxReply(id, util.Str(p[2].Get("id")), "session") {
			t.Fatal("protected folders can't be granted from a chat")
		}
		if !o.SandboxReply(id, util.Str(p[0].Get("id")), "session") {
			t.Fatal("session grant")
		}
		// 「始终允许」写文件夹也按项目记（只在这个项目里生效），记的是真实路径
		if !o.SandboxReply(id, util.Str(p[1].Get("id")), "always") || len(persisted) != 1 ||
			persisted[0] != (SandboxGrant{Kind: "folder", Value: filepath.FromSlash("/Users/me/.ai-usage/logs"), Project: realDir(proj)}) {
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
		deny("write", "/Users/me/.ai-usage/logs/b.log")
		deny("read:protected", "/Users/me/finance/a.pdf")
		if got := pendingOf(o, id); len(got) != 0 {
			t.Fatalf("answered items must not come back, got %v", util.Stringify(got))
		}
		// 授权进下一次启动的配置
		got := map[string]bool{}
		for _, g := range o.grantedFor(id) {
			got[g.Kind+":"+g.Value] = true
		}
		if !got["category:ssh"] || !got["folder:"+filepath.FromSlash("/Users/me/.ai-usage/logs")] {
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
				Always:    func() []SandboxGrant { return []SandboxGrant{{Kind: "file", Value: filepath.Join(tmp, ".zshrc")}} },
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

// 「始终允许」读凭据按项目记（另一个项目不生效），写入位置是全局的；任务预授权的类别直接生效；被挡下时发「等权限」通知
func TestSandboxProjectScopeAndPregrants(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(tmp, "repo")
	sub := filepath.Join(repo, "pkg")
	other := filepath.Join(tmp, "other")
	for _, d := range []string{filepath.Join(repo, ".git"), sub, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var persisted []SandboxGrant
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "ud", "h"), Home: tmp, DefaultCwd: repo, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{
				Enabled: func() bool { return true },
				Always:  func() []SandboxGrant { return persisted },
				Persist: func(g SandboxGrant) { persisted = append(persisted, g) },
			}})
		defer o.Dispose()
		var notices []*util.Obj
		o.events.On("permission-needed", func(v any) { notices = append(notices, v.(*util.Obj)) })

		a := util.Str(o.CreateTab(util.NewObj("backend", "claude", "cwd", sub, "activate", false)).Get("id"))
		b := util.Str(o.CreateTab(util.NewObj("backend", "claude", "cwd", other, "activate", false)).Get("id"))
		o.sbx.tokens = map[string]string{"ta": a, "tb": b}
		o.onSandboxDeny(sandbox.Denial{Token: "ta", Rule: "read:cloud", Path: filepath.Join(tmp, ".aws", "credentials")})
		o.onSandboxDeny(sandbox.Denial{Token: "ta", Rule: "read:secret-files", Path: filepath.Join(sub, ".env")})
		p := pendingOf(o, a)
		if len(p) != 2 || p[1].Get("kind") != "read" || len(notices) != 2 {
			t.Fatalf("pending = %v, notices = %d", util.Stringify(p), len(notices))
		}
		o.SandboxReply(a, util.Str(p[0].Get("id")), "always")
		o.SandboxReply(a, util.Str(p[1].Get("id")), "always")
		if len(persisted) != 2 || persisted[0].Project != repo || persisted[1] != (SandboxGrant{Kind: "read", Value: filepath.Join(sub, ".env"), Project: repo}) {
			t.Fatalf("persisted = %+v", persisted)
		}
		has := func(id string, g SandboxGrant) bool {
			for _, x := range o.grantedFor(id) {
				if x.Kind == g.Kind && x.Value == g.Value {
					return true
				}
			}
			return false
		}
		if !has(a, SandboxGrant{Kind: "category", Value: "cloud"}) || has(b, SandboxGrant{Kind: "category", Value: "cloud"}) {
			t.Fatal("a project-scoped grant applies inside that repo only")
		}
		// 另一个项目里同一类还会问
		o.onSandboxDeny(sandbox.Denial{Token: "tb", Rule: "read:cloud", Path: filepath.Join(tmp, ".aws", "config")})
		if len(pendingOf(o, b)) != 1 {
			t.Fatal("another project is asked again")
		}

		// 任务预授权：委派带来的类别（认不出的丢掉）
		c := util.Str(o.CreateTab(util.NewObj("backend", "codex", "cwd", other, "activate", false,
			"delegation", util.NewObj("goal", "g", "taskId", "task_1", "sandboxGrants", []any{"ssh", "bogus"}))).Get("id"))
		if !has(c, SandboxGrant{Kind: "category", Value: "ssh"}) || has(c, SandboxGrant{Kind: "category", Value: "bogus"}) {
			t.Fatalf("pregrants = %+v", o.grantedFor(c))
		}
		o.sbx.tokens["tc"] = c
		o.onSandboxDeny(sandbox.Denial{Token: "tc", Rule: "read:ssh", Path: filepath.Join(tmp, ".ssh", "config")})
		if len(pendingOf(o, c)) != 0 {
			t.Fatal("pre-granted categories are not asked")
		}
	})
}

// 撤销「始终允许」：删掉持久记录后，原标签、同项目的别的标签、空闲回收后的下一轮都不再带上它（不等策略通知）；
// 本会话授权不受影响；记录被拒时退回本会话授权；受保护文件夹照样拒
func TestSandboxAlwaysRevoked(t *testing.T) {
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(tmp, "repo")
	sub := filepath.Join(repo, "pkg")
	other := filepath.Join(tmp, "other")
	finance := filepath.Join(tmp, "finance")
	for _, d := range []string{filepath.Join(repo, ".git"), sub, other, finance} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// 假的持久记录：同一项不重复记（同 AddCliSandboxAllow）；reject 时不记（同 normalizeSandboxAllow 丢掉）
	var persisted []SandboxGrant
	reject := false
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "ud", "h"), Home: tmp, DefaultCwd: repo, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{
				Enabled:   func() bool { return true },
				Protected: func() []string { return []string{finance} },
				Always:    func() []SandboxGrant { return append([]SandboxGrant{}, persisted...) },
				Persist: func(g SandboxGrant) {
					if !reject && !slices.Contains(persisted, g) {
						persisted = append(persisted, g)
					}
				},
			}})
		defer o.Dispose()
		revoke := func(kind, value string) {
			persisted = slices.DeleteFunc(persisted, func(g SandboxGrant) bool { return g.Kind == kind && g.Value == value })
		}
		mk := func(cwd string) string {
			return util.Str(o.CreateTab(util.NewObj("backend", "claude", "cwd", cwd, "activate", false)).Get("id"))
		}
		a, b, c := mk(repo), mk(sub), mk(other)
		o.sbx.tokens = map[string]string{"ta": a, "tb": b, "tc": c}
		deny := func(tok, rule, path string) {
			o.onSandboxDeny(sandbox.Denial{Token: tok, Rule: rule, Op: "file-read-data", Path: path, Proc: "cat"})
		}
		reply := func(id, kind, value, choice string) {
			t.Helper()
			for _, p := range pendingOf(o, id) {
				if p.Get("kind") == kind && p.Get("value") == value {
					if !o.SandboxReply(id, util.Str(p.Get("id")), choice) {
						t.Fatalf("reply %s %s:%s", choice, kind, value)
					}
					return
				}
			}
			t.Fatalf("no pending %s:%s on %s: %v", kind, value, id, util.Stringify(pendingOf(o, id)))
		}
		has := func(id, kind, value string) bool {
			for _, g := range o.grantedFor(id) {
				if g.Kind == kind && g.Value == value {
					return true
				}
			}
			return false
		}
		folder := filepath.Join(tmp, "cache-dir")
		file := filepath.Join(tmp, "Documents", "notes.txt") // 所在文件夹太宽，只授权这一个文件
		env := filepath.Join(repo, ".env")

		// 四类「始终允许」各点一次；a、b 同时被拦下 cloud，两边都点「始终」（重复授权只记一条）。
		// 一个标签最多挂 5 条，分两批
		deny("ta", "read:cloud", filepath.Join(tmp, ".aws", "credentials"))
		deny("tb", "read:cloud", filepath.Join(tmp, ".aws", "config"))
		deny("ta", "write", filepath.Join(folder, "a.log"))
		deny("ta", "write", file)
		deny("ta", "read:secret-files", env)
		deny("ta", "read:ssh", filepath.Join(tmp, ".ssh", "config"))
		deny("tb", "read:keys", filepath.Join(tmp, ".gnupg", "x"))
		deny("tc", "read:cloud", filepath.Join(tmp, ".aws", "credentials"))
		reply(a, "category", "cloud", "always")
		reply(b, "category", "cloud", "always")
		reply(a, "folder", folder, "always")
		reply(a, "file", file, "always")
		reply(a, "read", env, "always")
		reply(a, "category", "ssh", "session")
		reply(c, "category", "cloud", "session")
		deny("ta", "read:keys", filepath.Join(tmp, ".gnupg", "y"))
		deny("ta", "read:protected", filepath.Join(finance, "a.pdf"))
		reply(a, "category", "keys", "session")
		reply(b, "category", "keys", "always")
		for _, p := range pendingOf(o, a) {
			if p.Get("kind") == "protected" && o.SandboxReply(a, util.Str(p.Get("id")), "always") {
				t.Fatal("protected folders can't be granted from a chat")
			}
		}
		reply(a, "protected", filepath.Join(finance, "a.pdf"), "deny")
		if len(persisted) != 5 {
			t.Fatalf("persisted = %+v", persisted)
		}
		for _, k := range []string{"cloud", "ssh", "keys"} {
			if !has(a, "category", k) {
				t.Fatalf("before revoking, a has %s: %+v", k, o.grantedFor(a))
			}
		}
		if !has(a, "folder", folder) || !has(a, "file", file) || !has(a, "read", env) || !has(b, "category", "cloud") {
			t.Fatalf("before revoking: a = %+v, b = %+v", o.grantedFor(a), o.grantedFor(b))
		}
		if p := sandbox.Profile(*o.buildSandboxSpec(o.tab(a), repo, util.NewObj())); strings.Contains(p, "read:cloud") {
			t.Fatal("granted category is not denied in the profile")
		}

		// 撤销：只删持久记录；策略通知还没到（异步）时新算的配置就已经不带了
		for _, g := range []SandboxGrant{{Kind: "category", Value: "cloud"}, {Kind: "folder", Value: folder},
			{Kind: "file", Value: file}, {Kind: "read", Value: env}, {Kind: "category", Value: "keys"}} {
			revoke(g.Kind, g.Value)
		}
		check := func(when string) {
			t.Helper()
			for _, id := range []string{a, b} {
				if has(id, "category", "cloud") {
					t.Fatalf("%s: revoked category still granted to %s: %+v", when, id, o.grantedFor(id))
				}
				s := o.buildSandboxSpec(o.tab(id), str(o.tab(id), "cwd"), util.NewObj())
				if s.Granted["cloud"] || slices.Contains(s.Writable, folder) || slices.Contains(s.WritableFiles, file) ||
					slices.Contains(s.ReadFiles, env) {
					t.Fatalf("%s: revoked grants still in %s's spec: %+v", when, id, s)
				}
				p := sandbox.Profile(*s)
				if !strings.Contains(p, "read:cloud") {
					t.Fatalf("%s: revoked category is denied again in the profile", when)
				}
				// 受保护文件夹：配置里还在，且拒写排在所有放行之后
				if !slices.Contains(s.Protected, finance) ||
					strings.LastIndex(p, "write:protected") < strings.LastIndex(p, "(allow file-write*") {
					t.Fatalf("%s: protected folder is no longer the final deny", when)
				}
			}
			if has(b, "category", "keys") {
				t.Fatalf("%s: b's revoked always-grant came back", when)
			}
			// 本会话授权：a 的 ssh、keys（同一项 b 点过「始终」又撤销）、c 的 cloud（同一项 a 撤销过）都还在
			if !has(a, "category", "ssh") || !has(a, "category", "keys") || !has(c, "category", "cloud") {
				t.Fatalf("%s: session grants were cleared: a = %+v, c = %+v", when, o.grantedFor(a), o.grantedFor(c))
			}
			if s := o.buildSandboxSpec(o.tab(a), repo, util.NewObj()); !s.Granted["ssh"] || !s.Granted["keys"] {
				t.Fatalf("%s: session grants missing from a's spec: %+v", when, s.Granted)
			}
		}
		check("before the notice")
		o.SandboxPolicyChanged()
		check("after the notice")
		// 空闲回收后的下一轮、新开的同项目标签：一样按当前记录算
		o.ReclaimIdleNow()
		check("after idle reclaim")
		if d := mk(sub); has(d, "category", "cloud") || has(d, "folder", folder) {
			t.Fatalf("a new tab in the project got a revoked grant: %+v", o.grantedFor(d))
		}

		// 撤销后再被拦下会重新问
		deny("ta", "read:cloud", filepath.Join(tmp, ".aws", "credentials"))
		if p := pendingOf(o, a); len(p) != 1 || p[0].Get("value") != "cloud" {
			t.Fatalf("a revoked grant is asked again, pending = %v", util.Stringify(p))
		}
		// 记录被拒（存不下）：这一次按本会话授权，撤销不了也不会丢
		reject = true
		reply(a, "category", "cloud", "always")
		if len(persisted) != 0 || !has(a, "category", "cloud") || has(b, "category", "cloud") {
			t.Fatalf("refused always-grant falls back to this session only: a = %+v, persisted = %+v", o.grantedFor(a), persisted)
		}
		o.SandboxPolicyChanged()
		if !has(a, "category", "cloud") {
			t.Fatal("a policy notice does not clear session grants")
		}
	})
}

// 沙箱说明：Claude 走附加系统提示；别的 CLI 只在 CLI 会话的第一条消息前带上
func TestSandboxNote(t *testing.T) {
	if !sandbox.Supported() {
		t.Skip("sandbox not supported here")
	}
	tmp := t.TempDir()
	idle := 0.0
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(tmp, "h"), Home: tmp, DefaultCwd: tmp, Logger: nopLogger{}, Ports: nopPorts{},
			IdleReclaimMs: &idle, Sandbox: &SandboxDeps{Enabled: func() bool { return true }}})
		defer o.Dispose()
		args := o.claudeSandboxArgs()
		if len(args) != 4 || args[2] != "--append-system-prompt" || !strings.Contains(args[3], "Operation not permitted") {
			t.Fatalf("claude args = %v", args)
		}
		tab := util.NewObj("backend", "codex")
		if got := o.withSandboxNote(tab, "codex", "hi"); !strings.HasSuffix(got, "\n\nhi") || !strings.Contains(got, "sandbox") {
			t.Fatalf("first turn = %q", got)
		}
		tab.Set("cliSessionId", "s1")
		if o.withSandboxNote(tab, "codex", "hi") != "hi" || o.withSandboxNote(util.NewObj(), "claude", "hi") != "hi" {
			t.Fatal("only the first message of a non-Claude session carries the note")
		}
	})
}

// 按项目的授权按真实路径比：符号链接进项目里的照样生效，链到别处的不算这个项目
func TestGrantAppliesRealPath(t *testing.T) {
	tmp := t.TempDir()
	proj := filepath.Join(tmp, "proj")
	other := filepath.Join(tmp, "other")
	for _, d := range []string{filepath.Join(proj, "sub"), other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	into := filepath.Join(tmp, "into")
	away := filepath.Join(tmp, "away")
	if os.Symlink(filepath.Join(proj, "sub"), into) != nil || os.Symlink(other, away) != nil {
		t.Skip("symlinks not available")
	}
	g := SandboxGrant{Kind: "folder", Value: "/x", Project: proj}
	if !grantApplies(g, into) {
		t.Fatal("a symlinked cwd inside the project gets the project's grants")
	}
	if grantApplies(g, away) || grantApplies(g, other) {
		t.Fatal("a cwd outside the project does not")
	}
	if !grantApplies(SandboxGrant{Kind: "folder", Value: "/x"}, other) {
		t.Fatal("grants without a project apply everywhere")
	}
}

func TestDropAgentEnv(t *testing.T) {
	env := util.NewObj("SSH_AUTH_SOCK", "/private/var/run/com.apple.launchd.x/Listeners", "PATH", "/bin")
	dropAgentEnv(&sandbox.Spec{Granted: map[string]bool{}}, env)
	if _, ok := env.Lookup("SSH_AUTH_SOCK"); ok || env.Get("PATH") != "/bin" {
		t.Fatalf("without the ssh category the agent socket is dropped: %v", env.Keys())
	}
	env = util.NewObj("SSH_AUTH_SOCK", "/x")
	dropAgentEnv(&sandbox.Spec{Granted: map[string]bool{"ssh": true}}, env)
	if env.Get("SSH_AUTH_SOCK") != "/x" {
		t.Fatal("with the ssh category granted it stays")
	}
}
