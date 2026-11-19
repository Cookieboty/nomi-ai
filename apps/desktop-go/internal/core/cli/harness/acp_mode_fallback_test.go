package harness

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/rpc"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func grokAcpTestOrch(t *testing.T) (*Orchestrator, string) {
	t.Helper()
	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	work := filepath.Join(tmp, "work")
	_ = os.MkdirAll(work, 0o755)
	_ = os.MkdirAll(filepath.Join(tmp, "docs", "nomi"), 0o755)
	acpLog := filepath.Join(tmp, "grok-acp.jsonl")
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	t.Setenv("NOMI_MOCK_DELAY_MS", "5")
	t.Setenv("NOMI_MOCK_GROK_STRICT_MODES", "1")
	t.Setenv("NOMI_MOCK_GROK_ACP_LOG", acpLog)
	t.Chdir(repoRoot(t))
	idle := 0.0
	o := New(Deps{
		Root:             filepath.Join(tmp, "harness"),
		Home:             tmp,
		DefaultCwd:       filepath.Join(tmp, "docs", "nomi"),
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		GrokAcp:          true,
	})
	return o, acpLog
}

type recordedAcpReq struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

func readAcpLog(t *testing.T, path string) []recordedAcpReq {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read ACP log %s: %v", path, err)
	}
	var out []recordedAcpReq
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var r recordedAcpReq
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("unmarshal ACP log line %q: %v", line, err)
		}
		out = append(out, r)
	}
	return out
}

func setModeParams(reqs []recordedAcpReq) []string {
	var out []string
	for _, r := range reqs {
		if r.Method == "session/set_mode" {
			if m, ok := r.Params["modeId"].(string); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

// fakeAcpPipe：内存 ACP 子进程桩，用于在 jsrt 协程内直接校验 applyAcpSessionMode 与 AvailableModes 行为。
type fakeAcpPipe struct {
	onStdout func(string)
	onClose  func(*int, string)
	onLine   func(*util.Obj)
	setModes []string
	killed   bool
}

func (f *fakeAcpPipe) PID() int                { return 1 }
func (f *fakeAcpPipe) ExitCode() *int          { return nil }
func (f *fakeAcpPipe) Killed() bool            { return f.killed }
func (f *fakeAcpPipe) Stdin() clisdk.StdinLike { return fakeAcpStdin{f} }
func (f *fakeAcpPipe) OnStdout(fn func(string)) {
	f.onStdout = fn
}
func (f *fakeAcpPipe) OnStderr(func(string)) {}
func (f *fakeAcpPipe) OnClose(fn func(*int, string)) {
	f.onClose = fn
}
func (f *fakeAcpPipe) OnError(func(error)) {}
func (f *fakeAcpPipe) Kill(string) bool {
	f.killed = true
	return true
}
func (f *fakeAcpPipe) send(obj *util.Obj) {
	if f.onStdout != nil {
		f.onStdout(util.Stringify(obj) + "\n")
	}
}

type fakeAcpStdin struct{ p *fakeAcpPipe }

func (s fakeAcpStdin) Writable() bool { return !s.p.killed }
func (s fakeAcpStdin) End()           { s.p.killed = true }
func (s fakeAcpStdin) Write(chunk string) bool {
	for _, line := range strings.Split(chunk, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		v, err := util.ParseString(line)
		if err != nil {
			continue
		}
		msg, _ := v.(*util.Obj)
		if msg == nil {
			continue
		}
		if msg.Get("method") == "session/set_mode" {
			if p, _ := msg.Get("params").(*util.Obj); p != nil {
				s.p.setModes = append(s.p.setModes, jsStr(p.Get("modeId")))
			}
		}
		if s.p.onLine != nil {
			s.p.onLine(msg)
		}
	}
	return true
}

func newTestAcpDriver(t *testing.T, modesPayload any, onSetMode func(id any, modeID string, pipe *fakeAcpPipe)) (*drivers.AcpDriver, *fakeAcpPipe) {
	t.Helper()
	pipe := &fakeAcpPipe{}
	pipe.onLine = func(msg *util.Obj) {
		id := msg.Get("id")
		switch jsStr(msg.Get("method")) {
		case "initialize":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("protocolVersion", 1.0)))
		case "session/new":
			res := util.NewObj("sessionId", "acp-s1")
			if modesPayload != nil {
				res.Set("modes", modesPayload)
			}
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", res))
		case "session/set_mode":
			modeID := ""
			if p, _ := msg.Get("params").(*util.Obj); p != nil {
				modeID = jsStr(p.Get("modeId"))
			}
			onSetMode(id, modeID, pipe)
		}
	}
	d := drivers.NewAcpDriver(drivers.AcpDriverOptions{Child: pipe, NewID: func() string { return "1" }})
	if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
		t.Fatalf("driver.Start: %v", err)
	}
	return d, pipe
}

func TestGrokStrictAcpModesFallbackAndSendSucceeds(t *testing.T) {
	t.Run("delegated bypass falls back to default and auto-approves permissions", func(t *testing.T) {
		t.Setenv("NOMI_MOCK_GROK_PERM", "1")
		o, acpLog := grokAcpTestOrch(t)
		defer jsrt.Run(o.Dispose)

		tab := jsrt.Call(func() *util.Obj {
			return o.CreateTab(util.NewObj(
				"backend", "grok",
				"permissionMode", "bypass",
				"activate", false,
				"delegation", util.NewObj("goal", "test grok", "taskId", "t-1"),
			))
		})
		id := str(tab, "id")
		awaitSend(t, o, id, "run echo")

		if got := jsrt.Call(func() string { return str(o.tab(id), "permissionMode") }); got != "bypass" {
			t.Fatalf("tab permissionMode=%q want bypass (must not be overwritten by current_mode_update default)", got)
		}
		if got := jsrt.Call(func() string { return str(o.tab(id), "permissionModeCli") }); got != "manual" {
			t.Fatalf("tab permissionModeCli=%q want manual", got)
		}
		modes := setModeParams(readAcpLog(t, acpLog))
		if len(modes) < 2 || modes[0] != "bypassPermissions" || modes[1] != "default" {
			t.Fatalf("set_mode sequence=%v, want [bypassPermissions default ...]", modes)
		}
		msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
		if text := str(msgs[len(msgs)-1], "content"); !strings.Contains(text, "【Mock Grok】acp") {
			t.Fatalf("unexpected reply: %q", text)
		}
	})

	t.Run("interactive auto falls back from acceptEdits to default", func(t *testing.T) {
		o, acpLog := grokAcpTestOrch(t)
		defer jsrt.Run(o.Dispose)

		tab := jsrt.Call(func() *util.Obj {
			return o.CreateTab(util.NewObj("backend", "grok", "permissionMode", "auto", "activate", false))
		})
		id := str(tab, "id")
		awaitSend(t, o, id, "hello grok")

		if got := jsrt.Call(func() string { return str(o.tab(id), "permissionMode") }); got != "auto" {
			t.Fatalf("tab permissionMode=%q want auto", got)
		}
		if got := jsrt.Call(func() string { return str(o.tab(id), "permissionModeCli") }); got != "manual" {
			t.Fatalf("tab permissionModeCli=%q want manual", got)
		}
		modes := setModeParams(readAcpLog(t, acpLog))
		if len(modes) < 2 || modes[0] != "acceptEdits" || modes[1] != "default" {
			t.Fatalf("set_mode sequence=%v, want [acceptEdits default ...]", modes)
		}
	})
}

func TestGrokSwitchAcpModeFallbackPreservesTargetMode(t *testing.T) {
	t.Setenv("NOMI_MOCK_GROK_PERM", "1")
	o, acpLog := grokAcpTestOrch(t)
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "grok", "permissionMode", "plan", "activate", false))
	})
	id := str(tab, "id")

	// plan 模式下不会自动放行权限：第一轮临时订阅并在 microtask 手动放行工具权限，
	// 轮末的 execute-plan 审批卡按拒绝处理以免自动切档并发出跟进，测完即撤掉监听器。
	manualApproved := 0
	off := jsrt.Call(func() func() {
		return o.Events().OnOff("event", func(v any) {
			x, _ := v.(*util.Obj)
			if x == nil || str(x, "tabId") != id {
				return
			}
			ev, _ := x.Get("event").(*util.Obj)
			if ev == nil || ev.Get("type") != "permission" {
				return
			}
			reqID := jsStr(ev.Get("id"))
			jsrt.QueueMicrotask(func() {
				if IsExecutePlanID(reqID) {
					o.ReplyPermission(id, reqID, false, "denied", "deny")
					return
				}
				manualApproved++
				o.ReplyPermission(id, reqID, true, "", "")
			})
		})
	})
	awaitSend(t, o, id, "inspect only")
	jsrt.Run(off)
	if manualApproved != 1 {
		t.Fatalf("expected 1 manual permission approval in plan mode, got %d", manualApproved)
	}

	// 从受支持的 plan 运行中切换到 bypass：bypassPermissions 被拒后回退 default，但标签模式仍为 bypass
	p := jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ApplyTabPermissionMode(id, "bypass", PermOpts{Confirmed: true})
	})
	res, err := jsrt.Block(p)
	if err != nil {
		t.Fatalf("ApplyTabPermissionMode(bypass) failed: %v", err)
	}
	if str(res, "permissionMode") != "bypass" {
		t.Fatalf("ApplyTabPermissionMode returned mode=%q want bypass", str(res, "permissionMode"))
	}
	if got := jsrt.Call(func() string { return str(o.tab(id), "permissionModeCli") }); got != "manual" {
		t.Fatalf("permissionModeCli=%q want manual", got)
	}

	// 无手动监听器时，第二轮必须依靠 allowIfBypass 自动批准权限并完成发送
	awaitSend(t, o, id, "now run tool")
	if manualApproved != 1 {
		t.Fatalf("manual listener should have been detached, got %d", manualApproved)
	}
	modes := setModeParams(readAcpLog(t, acpLog))
	wantSeq := []string{"plan", "bypassPermissions", "default"}
	if !reflect.DeepEqual(modes, wantSeq) {
		t.Fatalf("set_mode sequence=%v, want %v", modes, wantSeq)
	}
}

func TestAcpPlanModeNeverDegradesAndNon32602Fails(t *testing.T) {
	t.Run("non-32602 rpc error aborts send even in bypass", func(t *testing.T) {
		t.Setenv("NOMI_MOCK_GROK_SET_MODE", "error")
		o, _ := grokAcpTestOrch(t)
		defer jsrt.Run(o.Dispose)

		tab := jsrt.Call(func() *util.Obj {
			return o.CreateTab(util.NewObj(
				"backend", "grok",
				"permissionMode", "bypass",
				"activate", false,
				"delegation", util.NewObj("goal", "g", "taskId", "t-err"),
			))
		})
		id := str(tab, "id")
		p := jsrt.Call(func() *jsrt.Promise[*util.Obj] { return o.SendTab(id, "should fail", nil, false) })
		if _, err := jsrt.Block(p); err == nil {
			t.Fatal("expected error on -32603 mode rejection")
		}
	})

	t.Run("plan mode rejects -32602 without falling back to default", func(t *testing.T) {
		o := &Orchestrator{d: Deps{Logger: nopLogger{}}}
		var gotErr error
		var sent []string
		jsrt.Run(func() {
			d, pipe := newTestAcpDriver(t, nil, func(id any, modeID string, p *fakeAcpPipe) {
				p.send(util.NewObj(
					"jsonrpc", "2.0", "id", id,
					"error", util.NewObj("code", float64(-32602), "message", "Invalid params", "data", "unknown mode id: "+modeID),
				))
			})
			live := &acpLiveSession{
				backend:            "grok",
				driver:             d,
				unsupportedModeIDs: map[string]bool{},
			}
			_, gotErr = jsrt.Await(o.applyAcpSessionMode(live, "plan", nil, nil))
			sent = append([]string(nil), pipe.setModes...)
		})
		if gotErr == nil {
			t.Fatal("plan mode must return error when set_mode fails with -32602")
		}
		if !reflect.DeepEqual(sent, []string{"plan"}) {
			t.Fatalf("plan mode must never fall back to default; set_mode sent=%v", sent)
		}
		if !strings.Contains(gotErr.Error(), "unknown mode id: plan") {
			t.Fatalf("expected error data to propagate, got %q", gotErr.Error())
		}
	})

	t.Run("error helpers discriminate -32602 vs other failures", func(t *testing.T) {
		if !isUnsupportedAcpModeError(&rpc.Error{Code: float64(-32602), Msg: "Invalid params: unknown mode id: plan"}) {
			t.Fatal("expected -32602 to be detected as unsupported mode error")
		}
		if isUnsupportedAcpModeError(&rpc.Error{Code: float64(-32603), Msg: "mode rejected (mock)"}) {
			t.Fatal("-32603 must not be treated as unsupported mode error")
		}
		if isUnsupportedAcpModeError(errors.New("untrusted directory")) {
			t.Fatal("generic error must not be treated as unsupported mode error")
		}
		if isUnsupportedAcpModeError(nil) {
			t.Fatal("nil error must be false")
		}
		if !isUnsupportedAcpModeError(errors.New("unknown mode id: acceptEdits")) {
			t.Fatal("expected unknown mode id text to match")
		}
		if !isUnsupportedAcpModeError(errors.New("Invalid mode: foo")) {
			t.Fatal("expected invalid mode text to match")
		}
	})
}

func TestAcpAvailableModesFallbackAndGeminiUntrusted(t *testing.T) {
	t.Run("AvailableModes skips unsupported want and sends default directly", func(t *testing.T) {
		o := &Orchestrator{d: Deps{Logger: nopLogger{}}}
		var applied string
		var gotErr error
		var sent []string
		var avail []string
		jsrt.Run(func() {
			modes := util.NewObj(
				"currentModeId", "plan",
				"availableModes", []any{
					util.NewObj("id", "plan"),
					util.NewObj("id", "default"),
					util.NewObj("id", "default"),
				},
			)
			d, pipe := newTestAcpDriver(t, modes, func(id any, modeID string, p *fakeAcpPipe) {
				p.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj()))
			})
			avail = append([]string(nil), d.AvailableModes...)
			live := &acpLiveSession{
				backend:            "grok",
				driver:             d,
				unsupportedModeIDs: map[string]bool{},
			}
			applied, gotErr = jsrt.Await(o.applyAcpSessionMode(live, "bypass", "plan", nil))
			sent = append([]string(nil), pipe.setModes...)
		})
		if gotErr != nil {
			t.Fatalf("unexpected error: %v", gotErr)
		}
		if applied != "default" {
			t.Fatalf("applied=%q, want default", applied)
		}
		if !reflect.DeepEqual(avail, []string{"plan", "default"}) {
			t.Fatalf("AvailableModes=%v, want [plan default]", avail)
		}
		if !reflect.DeepEqual(sent, []string{"default"}) {
			t.Fatalf("expected direct fallback to default without trying bypassPermissions, sent=%v", sent)
		}
	})

	t.Run("Gemini untrusted error is never downgraded even with -32602", func(t *testing.T) {
		o := &Orchestrator{d: Deps{Logger: nopLogger{}}}
		var gotErr error
		var sent []string
		jsrt.Run(func() {
			d, pipe := newTestAcpDriver(t, nil, func(id any, modeID string, p *fakeAcpPipe) {
				p.send(util.NewObj(
					"jsonrpc", "2.0", "id", id,
					"error", util.NewObj("code", float64(-32602), "message", "Internal error: Cannot enable privileged approval modes in an untrusted folder."),
				))
			})
			live := &acpLiveSession{
				backend:            "gemini",
				driver:             d,
				unsupportedModeIDs: map[string]bool{},
			}
			_, gotErr = jsrt.Await(o.applyAcpSessionMode(live, "bypass", "default", nil))
			sent = append([]string(nil), pipe.setModes...)
		})
		if gotErr == nil {
			t.Fatal("gemini untrusted error must be returned")
		}
		if !reflect.DeepEqual(sent, []string{"yolo"}) {
			t.Fatalf("gemini untrusted error must not fall back to default, sent=%v", sent)
		}
	})
}
