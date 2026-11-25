package delegate

// 派给 Nomi（docs/features/scheduling-calendar.md）。

import (
	"context"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func nomiRaw(kv ...any) *util.Obj {
	o := util.NewObj("goal", "做一套 10 页的 PPT", "done_when", "deck.pptx 写进工作区")
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// bgCtx：登记为后台任务执行的 ctx（broker.isBackground 为真）
func bgCtx() context.Context {
	return desktop.WithBackground(context.Background(), &desktop.BackgroundRun{Level: 3})
}

func TestDelegateToNomiCreatesTask(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj("ws", "/work/deck"), ft)
	r := e.call(nil, "delegate_to_nomi", nomiRaw("context", "蓝色调", "kind", "writing"),
		tools.ExecContext{ConversationID: "c1", Cwd: "/work/deck", ProjectID: "p_test", ToolCallID: "call-1"})
	d := dataOf(r)
	if r.Get("ok") != true || d.Get("taskId") != "task_1" || d.Get("cli") != "nomi" || d.Get("status") != "running" {
		t.Fatal(util.Stringify(r))
	}
	if d.Has("isolationNote") {
		t.Fatal("派给 Nomi 的结果不该带 isolationNote", util.Stringify(d))
	}
	if !strings.Contains(util.Str(d.Get("summary")), "已交给后台的 Nomi") {
		t.Fatal(util.Str(d.Get("summary")))
	}
	c := ft.created[0]
	ex := c.Executor
	if *c.ConversationID != "c1" || c.Level != 4 || len(c.Paths) != 1 || c.Paths[0] != "/work/deck" || c.Category != "writing" ||
		ex.Kind != "nomi" || ex.Tools == nil || len(*ex.Tools) != 0 || *ex.Toolset != "conversation" || *ex.Cwd != "/work/deck" || ex.Project == nil || *ex.Project != "p_test" ||
		ex.Brief.DoneWhen != "deck.pptx 写进工作区" || *ex.Brief.Context != "蓝色调" || *ex.CallID != "call-1" ||
		c.Title != "Nomi · 做一套 10 页的 PPT" {
		t.Fatalf("%+v %+v", c, ex)
	}
	logs := util.Stringify(e.log.desktopSnapshot())
	if !strings.Contains(logs, `"authorizeIn"`) || !strings.Contains(logs, `"delegate_to_nomi"`) {
		t.Fatal(logs)
	}
	// 不需要 agent：没有标签
	if hl := e.log.harnessLog(); len(hl) != 0 {
		t.Fatal(hl)
	}
	audit := util.Stringify(e.log.auditSnapshot())
	if !strings.Contains(audit, `"delegate_to_nomi"`) || !strings.Contains(audit, `"allowed"`) {
		t.Fatal(audit)
	}
}

func TestDelegateToNomiModes(t *testing.T) {
	// 逐项确认也给高级权限（L4，不降级）；没有工作区时 authorize、paths 为空、类型缺省 writing
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj("mode", "manual"), ft)
	if r := e.call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{}); r.Get("ok") != true {
		t.Fatal(util.Stringify(r))
	}
	c := ft.created[0]
	if c.Level != 4 || len(c.Paths) != 0 || c.Executor.Cwd != nil || c.Category != "writing" {
		t.Fatalf("%+v", c)
	}
	if !strings.Contains(util.Stringify(e.log.desktopSnapshot()), `["authorize",`) {
		t.Fatal(util.Stringify(e.log.desktopSnapshot()))
	}
	// 计划档拒绝
	ft2 := newFakeTasks()
	if r := newTaskEnv(t, util.NewObj("mode", "plan"), ft2).call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{}); errCode(r) != "mode_blocked" {
		t.Fatal(util.Stringify(r))
	}
	// 用户拒绝不建任务
	ft3 := newFakeTasks()
	if r := newTaskEnv(t, util.NewObj("decisions", []any{"denied"}), ft3).call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{}); errCode(r) != "user_denied" {
		t.Fatal(util.Stringify(r))
	}
	if len(ft2.created)+len(ft3.created) != 0 {
		t.Fatal("建了任务")
	}
	// 没有持续任务：internal_error
	if r := newTaskEnv(t, util.NewObj(), nil).call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{}); errCode(r) != "internal_error" {
		t.Fatal(util.Stringify(r))
	}
	// 入参校验：kind 不在枚举里
	if r := newTaskEnv(t, util.NewObj(), newFakeTasks()).call(nil, "delegate_to_nomi", nomiRaw("kind", "prd"), tools.ExecContext{}); errCode(r) != "internal_error" {
		t.Fatal(util.Stringify(r))
	}
}

func TestChildPermissionMode(t *testing.T) {
	for _, tc := range []struct {
		nomi, tabDefault, want string
	}{
		{"plan", "auto", "plan"},
		{"manual", "auto", "manual"},
		{"acceptEdits", "auto", "acceptEdits"},
		{"auto", "plan", "auto"},
		{"auto", "acceptEdits", "auto"},
	} {
		if got := ChildPermissionMode(tc.nomi, tc.tabDefault); got != tc.want {
			t.Errorf("ChildPermissionMode(%q, %q) = %q, want %q", tc.nomi, tc.tabDefault, got, tc.want)
		}
	}
	for _, tc := range []struct {
		cli, nomi, tabDefault, want string
	}{
		{"claude", "auto", "plan", "bypass"},
		{"claude", "manual", "plan", "bypass"},
		{"claude", "acceptEdits", "manual", "bypass"},
		{"claude", "plan", "manual", "bypass"},
		{"codex", "manual", "plan", "bypass"},
		{"grok", "manual", "plan", "bypass"},
		{"grok", "acceptEdits", "manual", "bypass"},
		{"gemini", "manual", "plan", "bypass"},
		{"dsh", "manual", "plan", "bypass"},
		{"kimi", "manual", "plan", "bypass"},
		// minimax 没有全自动档（只有 plan / default），无论 Nomi 是什么模式都只能取它能给的最高档
		{"minimax", "auto", "plan", "manual"},
		{"minimax", "manual", "plan", "manual"},
	} {
		if got := ChildPermissionModeFor(tc.cli, tc.nomi, tc.tabDefault); got != tc.want {
			t.Errorf("ChildPermissionModeFor(%q, %q, %q) = %q, want %q", tc.cli, tc.nomi, tc.tabDefault, got, tc.want)
		}
		if got := DelegatePermissionMode(tc.cli); got != tc.want {
			t.Errorf("DelegatePermissionMode(%q) = %q, want %q", tc.cli, got, tc.want)
		}
	}
}

func TestDelegateToCliAutoModePassesBypass(t *testing.T) {
	e := newTaskEnv(t, util.NewObj("mode", "auto", "autoApprove", false, "tabDefault", "acceptEdits"), nil)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false, "cli", "claude"), tools.ExecContext{})
	if r.Get("ok") != true {
		t.Fatal(util.Stringify(r))
	}
	hl := e.log.harnessLog()
	if len(hl) == 0 {
		t.Fatal("delegate did not create a child tab")
	}
	created, ok := hl[0].([]any)
	if !ok || len(created) != 2 || created[0] != "createTab" {
		t.Fatalf("unexpected harness log: %v", hl)
	}
	opts, ok := created[1].(*util.Obj)
	if !ok || opts.Get("permissionMode") != "bypass" {
		t.Fatalf("child permission mode = %v, want bypass（委派是后台无人值守，不能停下来问）; opts=%s", opts.Get("permissionMode"), util.Stringify(opts))
	}
}

func TestDelegateToCliAlwaysAutoRegardlessOfNomiMode(t *testing.T) {
	for _, nomiMode := range []string{"manual", "acceptEdits", "auto"} {
		for _, autoApprove := range []bool{false, true} {
			for _, tc := range []struct {
				cli, want string
			}{
				{"grok", "bypass"},
				{"claude", "bypass"},
				{"codex", "bypass"},
				{"gemini", "bypass"},
				{"dsh", "bypass"},
				{"kimi", "bypass"},
				{"minimax", "manual"},
			} {
				e := newTaskEnv(t, util.NewObj("mode", nomiMode, "autoApprove", autoApprove, "tabDefault", "plan"), nil)
				e.h.sc.Set("installed", []any{tc.cli})
				r := e.call(nil, "delegate_to_cli", delegateRaw("background", false, "cli", tc.cli), tools.ExecContext{})
				if r.Get("ok") != true {
					t.Fatalf("nomi=%s autoApprove=%v cli=%s err=%s", nomiMode, autoApprove, tc.cli, util.Stringify(r))
				}
				hl := e.log.harnessLog()
				if len(hl) != 1 {
					t.Fatalf("expected exactly one createTab, got: %v", hl)
				}
				created, ok := hl[0].([]any)
				if !ok || len(created) != 2 || created[0] != "createTab" {
					t.Fatalf("unexpected harness log: %v", hl)
				}
				opts := created[1].(*util.Obj)
				if got := opts.Get("permissionMode"); got != tc.want {
					t.Fatalf("nomi=%s autoApprove=%v cli=%s: child permissionMode=%v, want %s", nomiMode, autoApprove, tc.cli, got, tc.want)
				}
			}
		}
	}
}

func TestDelegateToNomiDepth(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	if r := e.call(bgCtx(), "delegate_to_nomi", nomiRaw(), tools.ExecContext{}); errCode(r) != "delegation_depth" {
		t.Fatal(util.Stringify(r))
	}
	if r := e.call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{CallerTabID: "tab-1"}); errCode(r) != "delegation_depth" {
		t.Fatal(util.Stringify(r))
	}
	if len(ft.created) != 0 {
		t.Fatal("建了任务")
	}
}

func TestDelegateToNomiAnnounceNotFollowable(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	id := util.Str(dataOf(e.call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{ConversationID: "c"})).Get("taskId"))
	call := func(name string, kv ...any) *util.Obj {
		return e.call(nil, name, util.NewObj(kv...), tools.ExecContext{})
	}
	end := int64(10)
	ft.advance(id, tasks.StatusDone, &tasks.Attempt{EndedAt: &end,
		Result: &tasks.AttemptResult{Summary: "6 张图都进了素材库", Artifacts: []tasks.Artifact{}}}, nil)
	waitUntil(t, func() bool { return len(e.completed()) == 1 })
	p := e.completed()[0]
	if p.Get("taskId") != id || p.Get("cli") != "nomi" || p.Get("status") != "done" ||
		!strings.Contains(util.Str(p.Get("summary")), "素材库") || p.Has("isolationNote") || p.Get("conversationId") != "c" {
		t.Fatal(util.Stringify(p))
	}
	if errCode(call("delegate_followup", "taskId", id, "message", "x")) != "not_followable" {
		t.Fatal("not_followable")
	}
	if dataOf(call("delegate_status", "taskId", id)).Get("cli") != "nomi" {
		t.Fatal("status cli")
	}
	// 能停止：取消任务
	id2 := util.Str(dataOf(e.call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{})).Get("taskId"))
	if call("delegate_stop", "taskId", id2).Get("ok") != true || !contains(ft.commands, id2+":cancel:") {
		t.Fatal(ft.commands)
	}
}

// 后台 Nomi 生成的图片、写过的文件随结果回到来源对话
func TestDelegateToNomiAnnounceCarriesProducts(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj(), ft)
	id := util.Str(dataOf(e.call(nil, "delegate_to_nomi", nomiRaw(), tools.ExecContext{ConversationID: "c"})).Get("taskId"))
	end := int64(10)
	ft.advance(id, tasks.StatusDone, &tasks.Attempt{EndedAt: &end,
		Result: &tasks.AttemptResult{Summary: "", Artifacts: []tasks.Artifact{
			{Kind: tasks.ArtifactImage, Ref: "chat-asset://images/gen-1.png"},
			{Kind: tasks.ArtifactFile, Ref: "/w/notes.md"},
		}}}, nil)
	waitUntil(t, func() bool { return len(e.completed()) == 1 })
	p := e.completed()[0]
	imgs, _ := p.Get("images").([]any)
	files, _ := p.Get("changedFiles").([]any)
	if len(imgs) != 1 || imgs[0] != "chat-asset://images/gen-1.png" || len(files) != 1 || files[0] != "/w/notes.md" {
		t.Fatal(util.Stringify(p))
	}
}

func TestDelegateFromBackgroundForcesSync(t *testing.T) {
	ft := newFakeTasks()
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("text", "改好了")}), ft)
	r := e.call(bgCtx(), "delegate_to_cli", delegateRaw("background", true), tools.ExecContext{})
	if r.Get("ok") != true || dataOf(r).Get("status") != "done" {
		t.Fatal(util.Stringify(r))
	}
	if len(ft.created) != 0 {
		t.Fatal("后台执行里的委派不该建任务")
	}
	if sent := e.log.sentSnapshot(); len(sent) != 1 {
		t.Fatal(sent)
	}
}

func TestDelegateConfirmationCarriesEffectiveModeAndHostProtections(t *testing.T) {
	for _, tc := range []struct {
		name       string
		cli        string
		wantMode   string
		sandbox    string
		background bool
	}{
		{"claude sync sandbox on", "claude", "bypass", "on", false},
		{"minimax sync sandbox off", "minimax", "manual", "off", false},
		{"claude bg sandbox unsupported", "claude", "bypass", "unsupported", true},
		{"minimax bg sandbox on", "minimax", "manual", "on", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			sc := util.NewObj(
				"installed", []any{"claude", "minimax"},
				"granted", []any{dir},
				"recent", []any{dir},
			)
			log := &envLog{}
			h := &fakeHarness{sc: sc, base: dir, log: log, cancelCh: make(chan struct{}, 4)}
			dk := &fakeDesktop{sc: sc, base: dir, log: log}
			var ft *fakeTasks
			deps := Deps{
				Root:          t.TempDir(),
				Harness:       h,
				Desktop:       dk,
				Events:        fakeEvents{log},
				Edits:         NewEditLog(),
				SandboxStatus: func() string { return tc.sandbox },
			}
			if tc.background {
				ft = newFakeTasks()
				deps.Tasks = ft
			}
			svc := New(deps)
			defs := map[string]tools.Definition{}
			for _, x := range svc.Tools() {
				defs[x.Name] = x
			}
			res, err := defs["delegate_to_cli"].Execute(context.Background(), util.NewObj(
				"goal", "检查权限档展示",
				"done_when", "完成",
				"cli", tc.cli,
				"cwd", dir,
				"background", tc.background,
			), tools.ExecContext{ReqID: "req-confirm", ConversationID: "conv-confirm"})
			if err != nil || res.(*util.Obj).Get("ok") != true {
				t.Fatalf("delegate failed: err=%v res=%s", err, util.Stringify(res))
			}

			if len(dk.authInputs) != 1 || dk.authInputs[0].Delegate == nil {
				t.Fatalf("expected AuthorizeInput.Delegate metadata, got %+v", dk.authInputs)
			}
			gotMeta := dk.authInputs[0].Delegate
			if gotMeta.Cli != tc.cli || gotMeta.PermissionMode != tc.wantMode ||
				gotMeta.SandboxStatus != tc.sandbox || !gotMeta.WorkspaceGuard || !gotMeta.EnvScrub {
				t.Fatalf("unexpected DelegateConfirmMeta: %+v", gotMeta)
			}
			if !tc.background {
				// 同步路径核对 CreateTab 实际传出的 permissionMode 与确认卡显示一致（后台任务的标签在自己的 goroutine 里建）
				var created *util.Obj
				for _, ev := range log.harnessLog() {
					arr := ev.([]any)
					if arr[0] == "createTab" {
						created = arr[1].(*util.Obj)
						break
					}
				}
				if created == nil || util.Str(created.Get("permissionMode")) != tc.wantMode {
					t.Fatalf("CreateTab permissionMode = %v, want %q", created, tc.wantMode)
				}
			} else if got := DelegatePermissionMode(tc.cli); got != tc.wantMode {
				t.Fatalf("DelegatePermissionMode(%q) = %q, want %q", tc.cli, got, tc.wantMode)
			}
		})
	}
}
