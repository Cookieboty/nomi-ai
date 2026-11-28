package harness

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/builtin"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestAcpPluginCapabilityWiring(t *testing.T) {
	// 1. antigravity: 专属 ClientInfo/ClientCapabilities 与禁 elicitation 合规声明
	var agyOpts drivers.AcpDriverOptions
	cli.ApplyAcpCapability(&agyOpts, "antigravity")
	if !agyOpts.DisableElicitation {
		t.Fatal("antigravity must disable elicitation")
	}
	if agyOpts.ClientInfo == nil || agyOpts.ClientInfo.Get("name") != "nomi" {
		t.Fatalf("antigravity ClientInfo = %v", agyOpts.ClientInfo)
	}
	if agyOpts.ClientCapabilities == nil || agyOpts.ClientCapabilities.Get("terminal") != false {
		t.Fatalf("antigravity ClientCapabilities = %v", agyOpts.ClientCapabilities)
	}
	if agyOpts.SteerMethod != "" || agyOpts.SessionNotifyMethod != nil || agyOpts.ExtractToolName != nil {
		t.Fatalf("antigravity should not carry grok extensions: %+v", agyOpts)
	}

	// 2. grok: steer / compact / x.ai 通知与工具名提取收敛在插件内
	var grokOpts drivers.AcpDriverOptions
	cli.ApplyAcpCapability(&grokOpts, "grok")
	if grokOpts.DisableElicitation {
		t.Fatal("grok must not force DisableElicitation")
	}
	if grokOpts.SteerMethod != "_x.ai/interject" {
		t.Fatalf("grok SteerMethod = %q, want _x.ai/interject", grokOpts.SteerMethod)
	}
	if grokCap := builtin.Acp("grok"); grokCap == nil || grokCap.CompactMethod != "_x.ai/compact_conversation" {
		t.Fatalf("grok CompactMethod = %v", grokCap)
	}
	if grokOpts.SessionNotifyMethod == nil || !grokOpts.SessionNotifyMethod("_x.ai/session_notification") || grokOpts.SessionNotifyMethod("other/notify") {
		t.Fatal("grok SessionNotifyMethod matching failed")
	}
	if grokOpts.ExtractToolName == nil || grokOpts.ExtractToolName(util.NewObj("_meta", util.NewObj("x.ai/tool", util.NewObj("name", "custom_exec")))) != "custom_exec" {
		t.Fatal("grok ExtractToolName failed")
	}

	// 3. gemini: --include-directories 与 untrusted 判定收敛在插件内
	if got := cli.AcpExtraArgs("gemini", []string{"/a", "/b"}); !reflect.DeepEqual(got, []string{"--include-directories", "/a", "--include-directories", "/b"}) {
		t.Fatalf("gemini AcpExtraArgs = %v", got)
	}
	if gemCap := builtin.Acp("gemini"); gemCap == nil || gemCap.IsUntrustedModeError == nil || !gemCap.IsUntrustedModeError("Cannot enable privileged approval modes in an untrusted folder") {
		t.Fatal("gemini IsUntrustedModeError missing or failed")
	}
	code55 := 55
	if gemCap := builtin.Acp("gemini"); gemCap == nil || gemCap.IsUntrustedExit == nil || !gemCap.IsUntrustedExit(&code55, "") {
		t.Fatal("gemini IsUntrustedExit(55) failed")
	}

	// 4. kimi / minimax: 零专属 AcpCapability 负担，也不受其他 CLI 扩展污染
	for _, id := range []string{"kimi", "minimax"} {
		if builtin.Acp(id) != nil {
			t.Fatalf("%s should have nil AcpCapability, got %+v", id, builtin.Acp(id))
		}
		var opts drivers.AcpDriverOptions
		cli.ApplyAcpCapability(&opts, id)
		if opts.DisableElicitation || opts.SteerMethod != "" || opts.ClientInfo != nil || opts.SessionNotifyMethod != nil || opts.ExtractToolName != nil {
			t.Fatalf("%s received unexpected ACP capability options: %+v", id, opts)
		}
		if got := cli.AcpExtraArgs(id, []string{"/a"}); len(got) != 0 {
			t.Fatalf("%s unexpected AcpExtraArgs = %v", id, got)
		}
	}
}

func TestStandardAcpCliGracefulCloseSession(t *testing.T) {
	tmp := t.TempDir()
	work := filepath.Join(tmp, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	idle := 0.0
	o := New(Deps{
		Root:             filepath.Join(tmp, "harness"),
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	var methods []string
	pipe := &fakeAcpPipe{}
	pipe.onLine = func(msg *util.Obj) {
		id := msg.Get("id")
		m := jsStr(msg.Get("method"))
		methods = append(methods, m)
		switch m {
		case "initialize":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj(
				"protocolVersion", 1.0,
				"agentCapabilities", util.NewObj("sessionCapabilities", util.NewObj("close", util.NewObj())),
			)))
		case "session/new":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("sessionId", "kimi-s1")))
		case "session/close":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj()))
		}
	}

	jsrt.Run(func() {
		drv := drivers.NewAcpDriver(drivers.AcpDriverOptions{Child: pipe, NewID: func() string { return "1" }})
		if _, err := jsrt.Await(drv.Start(clisdk.StartOptions{Cwd: work})); err != nil {
			t.Fatalf("drv.Start: %v", err)
		}
		tab := o.CreateTab(util.NewObj("backend", "kimi", "activate", false))
		tid := str(tab, "id")
		sid := "kimi-s1"
		o.live.setAcp(tid, &acpLiveSession{backend: "kimi", driver: drv, sessionID: &sid})
		o.teardownAcpLive(tid)
	})

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		found := false
		for _, m := range methods {
			if m == "session/close" {
				found = true
				break
			}
		}
		if found {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	foundClose := false
	for _, m := range methods {
		if m == "session/close" {
			foundClose = true
			break
		}
	}
	if !foundClose {
		t.Fatalf("expected standard ACP CLI (kimi) to send session/close when supported, got methods=%v", methods)
	}
}

func TestGrokAcpCapabilityDriverWiring(t *testing.T) {
	runCase := func(backend string) []string {
		pipe := &fakeAcpPipe{}
		pipe.onLine = func(msg *util.Obj) {
			id := msg.Get("id")
			switch jsStr(msg.Get("method")) {
			case "initialize":
				pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("protocolVersion", 1.0)))
			case "session/new":
				pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("sessionId", "s-1")))
			case "session/prompt":
				pipe.send(util.NewObj("jsonrpc", "2.0", "method", "_x.ai/session_notification", "params", util.NewObj(
					"sessionId", "s-1",
					"update", util.NewObj("sessionUpdate", "auto_compact_started"),
				)))
				pipe.send(util.NewObj("jsonrpc", "2.0", "method", "session/update", "params", util.NewObj(
					"sessionId", "s-1",
					"update", util.NewObj(
						"sessionUpdate", "tool_call",
						"toolCallId", "tc-1",
						"kind", "execute",
						"status", "completed",
						"_meta", util.NewObj("x.ai/tool", util.NewObj("name", "grok_bash")),
					),
				)))
				pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("stopReason", "end_turn")))
			}
		}
		opts := drivers.AcpDriverOptions{Child: pipe, NewID: func() string { return "1" }}
		cli.ApplyAcpCapability(&opts, backend)
		drv := drivers.NewAcpDriver(opts)
		var out []string
		jsrt.Run(func() {
			if _, err := jsrt.Await(drv.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
				t.Fatalf("drv.Start(%s): %v", backend, err)
			}
			drv.On(func(se clisdk.SessionEvent) {
				if se != nil && se.Get("kind") == "harness" {
					out = append(out, util.Stringify(se.Get("event")))
				}
			})
			if _, err := jsrt.Await(drv.Send(clisdk.TurnInput{Text: "hi"})); err != nil {
				t.Fatalf("drv.Send(%s): %v", backend, err)
			}
		})
		return out
	}

	grokEvents := runCase("grok")
	if len(grokEvents) != 2 {
		t.Fatalf("grok events = %v, want 2 (auto_compact_started + grok_bash)", grokEvents)
	}
	if v, _ := util.ParseString(grokEvents[0]); util.AsObj(v).Get("kind") != "compact" {
		t.Fatalf("grok event[0] = %s, want compact status", grokEvents[0])
	}
	if v, _ := util.ParseString(grokEvents[1]); util.AsObj(v).Get("name") != "grok_bash" {
		t.Fatalf("grok event[1] = %s, want name=grok_bash", grokEvents[1])
	}

	kimiEvents := runCase("kimi")
	if len(kimiEvents) != 1 {
		t.Fatalf("kimi should ignore _x.ai/session_notification, got %v", kimiEvents)
	}
	if v, _ := util.ParseString(kimiEvents[0]); util.AsObj(v).Get("name") != "run_shell_command" {
		t.Fatalf("kimi should use standard tool name without x.ai meta override, got %s", kimiEvents[0])
	}
}
