package harness

import (
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func ptr(s string) *string { return &s }

// 「自动」默认原样下发：用户选了什么模型、换了哪个供应商，都不该被我们按名字猜着改档。
// 能不能跑是端点能力问题（分类器附带请求有没有透传），不是模型名问题。
func TestClaudeAutoSentAsIsForAnyModel(t *testing.T) {
	o := &Orchestrator{autoMode: cli.NewAutoModeTable(t.TempDir(), nil)}
	for _, model := range []string{
		"", "claude-fable-5", "amux/claude-fable-5", "amux/deepseek-v4.1-flash", "amux/gpt-6.1-terra",
		"my-relay/some-alias-that-is-claude", "claude-but-not-really",
	} {
		key := cli.AutoModeKey("https://relay.example/v1", model)
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, key); got != "auto" {
			t.Errorf("模型 %q：学到跑不通之前必须原样下发 auto，实际 %q", model, got)
		}
		if tab.Get("permissionModeCli") != nil {
			t.Errorf("模型 %q 不该记 permissionModeCli", model)
		}
	}
}

// 学到这个「端点 + 模型」上 auto 跑不通之后，才降 acceptEdits（不是 bypass），并留痕。
func TestClaudeAutoFallsBackAfterLearned(t *testing.T) {
	root := t.TempDir()
	o := &Orchestrator{autoMode: cli.NewAutoModeTable(root, nil)}
	key := cli.AutoModeKey("https://relay.example/v1", "amux/deepseek-v4.1-flash")
	o.autoMode.NoteUnsupported(key, "auto_mode_no_check_in_session")

	tab := util.NewObj("backend", "claude", "permissionMode", "auto")
	if got := o.claudeLaunchMode(tab, key); got != "acceptEdits" {
		t.Fatalf("学到之后应降 acceptEdits，实际 %q", got)
	}
	if got := util.Str(tab.Get("permissionModeCli")); got != "acceptEdits" {
		t.Fatalf("应记 permissionModeCli=acceptEdits，实际 %q", got)
	}
	// 换个端点或换个模型 → 重新按 auto 试，不因为别处失败就牵连
	for _, k := range []string{
		cli.AutoModeKey("https://other.example/v1", "amux/deepseek-v4.1-flash"),
		cli.AutoModeKey("https://relay.example/v1", "amux/gpt-6.1-terra"),
		cli.AutoModeKey("", "amux/deepseek-v4.1-flash"),
	} {
		tab := util.NewObj("backend", "claude", "permissionMode", "auto")
		if got := o.claudeLaunchMode(tab, k); got != "auto" {
			t.Errorf("%s 应重新按 auto 下发，实际 %q", k, got)
		}
	}
	// 只有 auto 受影响
	for _, mode := range []string{"plan", "manual", "acceptEdits", "bypass"} {
		tab := util.NewObj("backend", "claude", "permissionMode", mode)
		if got := o.claudeLaunchMode(tab, key); got != mode {
			t.Errorf("%s 不该被改，实际 %q", mode, got)
		}
	}
}

// 学到的结果要落盘：重启后不该再白耗一轮。
func TestAutoModeTablePersists(t *testing.T) {
	root := t.TempDir()
	key := cli.AutoModeKey("https://relay.example/v1", "amux/deepseek-v4.1-flash")
	cli.NewAutoModeTable(root, nil).NoteUnsupported(key, "auto_mode_no_check_in_session")
	again := cli.NewAutoModeTable(root, nil)
	if got := again.Unsupported(key); got != "auto_mode_no_check_in_session" {
		t.Fatalf("重启后应还记得，实际 %q", got)
	}
	if got := again.Unsupported(cli.AutoModeKey("https://relay.example/v1", "other")); got != "" {
		t.Fatalf("不该串到别的模型，实际 %q", got)
	}
}

func TestAutoModeKey(t *testing.T) {
	if got := cli.AutoModeKey("", ""); got != "official|default" {
		t.Errorf("key = %q", got)
	}
	if got := cli.AutoModeKey("https://relay.example/v1", "amux/m"); got != "https://relay.example/v1|amux/m" {
		t.Errorf("key = %q", got)
	}
}

func TestManagedDelegatedClaudeFallsBackFromAuto(t *testing.T) {
	o := &Orchestrator{autoMode: cli.NewAutoModeTable(t.TempDir(), nil)}
	key := cli.AutoModeKey("", "claude-opus-4-6")

	delegated := util.NewObj("backend", "claude", "permissionMode", "auto",
		"delegation", util.NewObj("by", "nomi", "taskId", "t1"))
	if got := o.claudeLaunchMode(delegated, key); got != "acceptEdits" {
		t.Fatalf("managed delegated task must launch Claude in acceptEdits, got %q", got)
	}
	if got := util.Str(delegated.Get("permissionModeCli")); got != "acceptEdits" {
		t.Fatalf("expected permissionModeCli=acceptEdits, got %q", got)
	}

	// 用户接管后不再是托管任务，恢复按交互标签（auto）下发
	delegated.Get("delegation").(*util.Obj).Set("takenOver", true)
	if got := o.claudeLaunchMode(delegated, key); got != "auto" {
		t.Fatalf("takenOver tab should restore auto launch mode, got %q", got)
	}
	if delegated.Get("permissionModeCli") != nil {
		t.Fatalf("takenOver tab should clear permissionModeCli, got %v", delegated.Get("permissionModeCli"))
	}
}

func TestLoopbackGatewayNormalizesCapKeyAcrossPorts(t *testing.T) {
	m := "amux/deepseek-v4.1-flash"
	ov := overrides{model: &m}
	k1 := claudeCapKey(&tabLaunch{env: util.NewObj("ANTHROPIC_BASE_URL", "http://127.0.0.1:51234/anthropic")}, ov)
	k2 := claudeCapKey(&tabLaunch{env: util.NewObj("ANTHROPIC_BASE_URL", "http://localhost:62345/anthropic")}, ov)
	k3 := claudeCapKey(&tabLaunch{env: util.NewObj("ANTHROPIC_BASE_URL", "http://[::1]:59999/anthropic")}, ov)
	want := "nomi-gateway|amux/deepseek-v4.1-flash"
	if k1 != want || k2 != want || k3 != want {
		t.Fatalf("loopback endpoints should normalize to %q, got %q, %q, %q", want, k1, k2, k3)
	}
	ext := claudeCapKey(&tabLaunch{env: util.NewObj("ANTHROPIC_BASE_URL", "https://relay.example/v1")}, ov)
	if ext != "https://relay.example/v1|amux/deepseek-v4.1-flash" {
		t.Fatalf("external endpoint should stay untouched, got %q", ext)
	}
}

func TestDelegatedCreateTabAndRebindAllowInternalBypassAndReuseChecksLaunchMode(t *testing.T) {
	root := t.TempDir()
	idle := float64(0)
	jsrt.Run(func() {
		o := New(Deps{Root: filepath.Join(root, "harness"), Home: root, DefaultCwd: root, Logger: nopLogger{}, Ports: nopPorts{}, IdleReclaimMs: &idle})
		defer o.Dispose()
		o.SetPermissionDefaults("auto", nil, false, nil, nil)

		// 非委派标签未确认 bypass 时不得生效
		plain := o.CreateTab(util.NewObj("backend", "claude", "cwd", root, "permissionMode", "bypass", "activate", false))
		if got := str(plain, "permissionMode"); got != "auto" {
			t.Fatalf("plain tab must ignore unconfirmed bypass, got %q", got)
		}

		// 带 delegation / subagentOf 的内部委派标签允许直接落到 bypass
		delTab := o.CreateTab(util.NewObj("backend", "claude", "cwd", root, "permissionMode", "bypass", "activate", false,
			"delegation", util.NewObj("goal", "test", "taskId", "task-1")))
		if got := str(delTab, "permissionMode"); got != "bypass" {
			t.Fatalf("delegated tab should allow internal bypass, got %q", got)
		}

		subTab := o.CreateTab(util.NewObj("backend", "claude", "cwd", root, "permissionMode", "bypass", "activate", false,
			"subagentOf", util.NewObj("tabId", "parent", "agentId", "a1")))
		if got := str(subTab, "permissionMode"); got != "bypass" {
			t.Fatalf("subagentOf tab should allow internal bypass, got %q", got)
		}

		// RebindDelegation 也能把权限切回 bypass
		reuseTab := o.CreateTab(util.NewObj("backend", "claude", "cwd", root, "permissionMode", "acceptEdits", "activate", false,
			"delegation", util.NewObj("goal", "g0", "taskId", "t0")))
		rid := str(reuseTab, "id")
		if !o.RebindDelegation(rid, util.NewObj("goal", "g1", "taskId", "t1", "expectTaskId", "t0", "permissionMode", "bypass")) {
			t.Fatal("RebindDelegation returned false")
		}
		if got := str(o.tab(rid), "permissionMode"); got != "bypass" {
			t.Fatalf("RebindDelegation did not apply bypass: got %q", got)
		}

		// reusableClaude 在 AutoModeTable 学到不支持后拒绝复用 launchMode=auto 的旧进程
		autoTab := o.CreateTab(util.NewObj("backend", "claude", "cwd", root, "permissionMode", "auto", "activate", false))
		aid := str(autoTab, "id")
		key := cli.AutoModeKey("", "")
		o.live.setClaude(aid, &claudeLiveSession{
			child:          gate(fakeChild{}),
			cwd:            root,
			permissionMode: "auto",
			launchMode:     "auto",
			capKey:         key,
			launchSig:      officialLaunch.sig,
			modelSig:       officialLaunch.modelSig,
		})
		if got := o.reusableClaude(autoTab, officialLaunch); got == nil {
			t.Fatal("before learning unsupported, live session with matching launchMode=auto should be reusable")
		}
		o.noteAutoModeBlocked(aid, o.live.claude[aid], util.NewObj("type", "error", "code", "auto_mode_no_check_in_session"))
		if !o.live.claude[aid].recycleAfterTurn || o.live.claude[aid].launchMode != "acceptEdits" {
			t.Fatalf("expected live session to mark recycleAfterTurn and switch launchMode, got %+v", o.live.claude[aid])
		}
		// 模拟刚写入 AutoModeTable 后尚未清零前的重判：假使 launchMode 仍为 auto，也绝不复用
		o.live.claude[aid].launchMode = "auto"
		if got := o.reusableClaude(autoTab, officialLaunch); got != nil {
			t.Fatal("after AutoModeTable learned unsupported, reusableClaude must not reuse launchMode=auto process")
		}
		// Cleanup fake session before Dispose calls teardownClaudeLive on driver=nil
		o.live.delClaude(aid)
	})
}
