package harness

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk/drivers"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestAntigravityModelCatalogForAndSyncAcpOverrides(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)
	_ = os.WriteFile(filepath.Join(agyCliDir, "settings.json"), []byte(`{"model":"gemini-4-neon-xhigh"}`), 0o600)

	mockJS := filepath.Join(tmp, "mock-agy.js")
	jsSrc := `'use strict';
const fs = require('fs');
const readline = require('readline');
if (process.argv.slice(2)[0] === 'models') {
  if (process.env.MOCK_AGY_FAIL_MODELS === '1') {
    process.stderr.write('models subcommand failed\n');
    process.exit(1);
  }
  process.stdout.write([
    '  auto                           Auto',
    '  gemini-4-neon-low              Gemini 4 Neon (Low)',
    '  gemini-4-neon-xhigh            Gemini 4 Neon (Extra High)',
    '  gemini-pro-orchestrator-neon   Gemini Pro Orchestrator Neon',
    '  gpt-oss-120b-medium            GPT-OSS 120B (Medium)'
  ].join('\n') + '\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  if (process.env.MOCK_AGY_RPC_LOG) {
    fs.appendFileSync(process.env.MOCK_AGY_RPC_LOG, s + '\n', 'utf8');
  }
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  if (m.method === 'initialize') {
    reply({ protocolVersion: 1 });
  } else if (m.method === 'session/new') {
    reply({
      sessionId: 'acp-cat-1',
      models: {
        currentModelId: 'gemini-4-neon-xhigh',
        availableModels: [
          { modelId: 'auto', name: 'Auto' },
          { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
          { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (Extra High)' },
          { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
        ]
      }
    });
  } else if (m.method === 'session/close') {
    reply({});
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	// 1. Prefer `agy models` CLI output (returns 4 aggregated models) without spawning ACP
	rpcLog := filepath.Join(tmp, "cat-rpc.log")
	t.Setenv("MOCK_AGY_RPC_LOG", rpcLog)
	cat, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ModelCatalogFor("antigravity", false, "local")
	}))
	if err != nil {
		t.Fatalf("ModelCatalogFor: %v", err)
	}
	models, _ := cat.Get("models").([]any)
	if len(models) != 4 {
		t.Fatalf("len(models) = %d, want 4 (%s)", len(models), util.Stringify(cat))
	}
	if raw, _ := os.ReadFile(rpcLog); len(raw) > 0 {
		t.Fatalf("expected agy models CLI discovery without ACP spawn, got RPC log:\n%s", string(raw))
	}

	// 2. Fallback to ACP session/new when `agy models` fails (ACP mock returns 3 aggregated models)
	t.Setenv("MOCK_AGY_FAIL_MODELS", "1")
	fbCat, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ModelCatalogFor("antigravity", true, "local")
	}))
	if err != nil {
		t.Fatalf("ModelCatalogFor ACP fallback: %v", err)
	}
	fbModels, _ := fbCat.Get("models").([]any)
	if len(fbModels) != 3 {
		t.Fatalf("fallback len(models) = %d, want 3 (%s)", len(fbModels), util.Stringify(fbCat))
	}
	if raw, _ := os.ReadFile(rpcLog); !strings.Contains(string(raw), `"clientInfo":{"name":"nomi"`) {
		t.Fatalf("ACP discovery initialize must include clientInfo:\n%s", string(raw))
	}

	// Now verify syncAcpOverrides maps aggregated base + effort -> suffixed wire model ID using SessionRaw fallback when cache cleared
	var setModels []string
	var setConfigs []string
	pipe := &fakeAcpPipe{}
	pipe.onLine = func(msg *util.Obj) {
		id := msg.Get("id")
		switch jsStr(msg.Get("method")) {
		case "initialize":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj("protocolVersion", 1.0)))
		case "session/new":
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj(
				"sessionId", "s-agy-1",
				"models", util.NewObj(
					"currentModelId", "auto",
					"availableModels", []any{
						util.NewObj("modelId", "auto", "name", "Auto"),
						util.NewObj("modelId", "gemini-4-neon-low", "name", "Gemini 4 Neon (Low)"),
						util.NewObj("modelId", "gemini-4-neon-high", "name", "Gemini 4 Neon (High)"),
						util.NewObj("modelId", "gemini-4-neon-xhigh", "name", "Gemini 4 Neon (Extra High)"),
						util.NewObj("modelId", "gpt-oss-120b-medium", "name", "GPT-OSS 120B (Medium)"),
					},
				),
			)))
		case "session/set_model":
			if p := util.AsObj(msg.Get("params")); p != nil {
				setModels = append(setModels, jsStr(p.Get("modelId")))
			}
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj()))
		case "session/set_config_option":
			if p := util.AsObj(msg.Get("params")); p != nil {
				setConfigs = append(setConfigs, jsStr(p.Get("configId"))+"="+jsStr(p.Get("value")))
			}
			pipe.send(util.NewObj("jsonrpc", "2.0", "id", id, "result", util.NewObj()))
		}
	}

	jsrt.Run(func() {
		drv := drivers.NewAcpDriver(drivers.AcpDriverOptions{Child: pipe, NewID: func() string { return "1" }})
		if _, err := jsrt.Await(drv.Start(clisdk.StartOptions{Cwd: work})); err != nil {
			t.Fatalf("drv.Start: %v", err)
		}
		o.InvalidateModelCatalog("antigravity") // force fallback to drv.SessionRaw

		tab := o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
		sid := "s-agy-1"
		live := &acpLiveSession{backend: "antigravity", driver: drv, sessionID: &sid}

		o.SetTabModel(str(tab, "id"), "gemini-4-neon", "local")
		o.SetTabReasoningEffort(str(tab, "id"), "high")
		ok, err := jsrt.Await(o.syncAcpOverrides(o.tab(str(tab, "id")), live))
		if err != nil || !ok {
			t.Fatalf("syncAcpOverrides 1 failed: ok=%v err=%v", ok, err)
		}

		// Changing ONLY effort on an aggregated model must re-send session/set_model with the new suffixed ID
		o.SetTabReasoningEffort(str(tab, "id"), "xhigh")
		ok, err = jsrt.Await(o.syncAcpOverrides(o.tab(str(tab, "id")), live))
		if err != nil || !ok {
			t.Fatalf("syncAcpOverrides 2 failed: ok=%v err=%v", ok, err)
		}

		// Auto model keeps wireModel="auto" and skips session/set_config_option
		o.SetTabModel(str(tab, "id"), "auto", "local")
		ok, err = jsrt.Await(o.syncAcpOverrides(o.tab(str(tab, "id")), live))
		if err != nil || !ok {
			t.Fatalf("syncAcpOverrides 3 failed: ok=%v err=%v", ok, err)
		}
	})

	if !reflect.DeepEqual(setModels, []string{"gemini-4-neon-high", "gemini-4-neon-xhigh", "auto"}) {
		t.Fatalf("SetSessionModel calls = %#v, want [gemini-4-neon-high gemini-4-neon-xhigh auto]", setModels)
	}
	if len(setConfigs) != 0 {
		t.Fatalf("unexpected SetConfigOption calls = %#v (got strings %s)", setConfigs, strings.Join(setConfigs, ","))
	}
}

func TestAntigravityRunAcpTopLevelUsage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)

	mockJS := filepath.Join(tmp, "mock-agy-usage.js")
	jsSrc := `'use strict';
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  const notify = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-u1', update } }) + '\n');
  if (m.method === 'initialize') {
    reply({ protocolVersion: 1 });
  } else if (m.method === 'session/new') {
    reply({ sessionId: 's-u1', modes: { currentModeId: 'default' } });
  } else if (m.method === 'session/set_mode') {
    reply({});
  } else if (m.method === 'session/prompt') {
    notify({ sessionUpdate: 'usage_update', used: 0, size: 1000000 });
    notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
    reply({
      stopReason: 'end_turn',
      usage: { inputTokens: 320, outputTokens: 64, cachedReadTokens: 200, cachedWriteTokens: 12, thoughtTokens: 24, totalTokens: 420 }
    });
  } else if (m.method === 'session/close') {
    reply({});
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
	})
	id := str(tab, "id")
	awaitSend(t, o, id, "hello")

	msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	last := msgs[len(msgs)-1]
	u := util.AsObj(last.Get("usage"))
	if u == nil || u.Get("inputTokens") != float64(320) || u.Get("outputTokens") != float64(64) ||
		u.Get("cacheReadTokens") != float64(200) || u.Get("cacheWriteTokens") != float64(12) ||
		u.Get("thoughtTokens") != float64(24) || u.Get("totalTokens") != float64(420) ||
		u.Get("contextTokens") != float64(0) || u.Get("contextWindow") != float64(1000000) {
		t.Fatalf("tab message usage = %v", u)
	}
}

func TestAntigravityTabTitleSyncAndModelPersistence(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)

	mockJS := filepath.Join(tmp, "mock-agy-title.js")
	jsSrc := `'use strict';
const readline = require('readline');
let turnCount = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  const notify = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-title-1', update } }) + '\n');
  if (m.method === 'initialize') {
    reply({ protocolVersion: 1 });
  } else if (m.method === 'session/new') {
    reply({
      sessionId: 's-title-1',
      modes: { currentModeId: 'default' },
      models: {
        currentModelId: 'auto',
        availableModels: [
          { modelId: 'auto', name: 'Auto' },
          { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
          { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }
        ]
      }
    });
  } else if (m.method === 'session/set_mode' || m.method === 'session/set_model' || m.method === 'session/close') {
    reply({});
  } else if (m.method === 'session/prompt') {
    turnCount += 1;
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply ' + turnCount } });
    reply({ stopReason: 'end_turn' });
    const nextTitle = turnCount === 1 ? 'Antigravity Post-Turn Title' : 'Late Title After Rename';
    setTimeout(() => {
      notify({ sessionUpdate: 'session_info_update', title: nextTitle });
    }, 30);
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
	})
	id := str(tab, "id")

	// Turn 1: default model (auto) without preloading catalog; post-turn session_info_update updates tab title.
	awaitSend(t, o, id, "Explain ACP protocol")
	msgs1 := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	if got := msgs1[len(msgs1)-1].Get("model"); got != "auto" {
		t.Fatalf("turn 1 model = %v, want auto", got)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		curTitle := jsrt.Call(func() string { return str(o.tab(id), "title") })
		if curTitle == "Antigravity Post-Turn Title" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if curTitle := jsrt.Call(func() string { return str(o.tab(id), "title") }); curTitle != "Antigravity Post-Turn Title" {
		t.Fatalf("tab title after post-turn session_info_update = %q, want Antigravity Post-Turn Title", curTitle)
	}

	// Manual rename prevents later async session_info_update from overwriting user's title.
	jsrt.Run(func() { o.RenameTab(id, "Custom Tab Name") })

	// Turn 2: aggregated model + high effort resolves to gemini-4-neon-high via SessionRaw without catalog preload.
	jsrt.Run(func() {
		o.SetTabModel(id, "gemini-4-neon", "local")
		o.SetTabReasoningEffort(id, "high")
	})
	awaitSend(t, o, id, "Second turn")

	msgs2 := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	if got := msgs2[len(msgs2)-1].Get("model"); got != "gemini-4-neon-high" {
		t.Fatalf("turn 2 model = %v, want gemini-4-neon-high", got)
	}

	time.Sleep(80 * time.Millisecond)
	if curTitle := jsrt.Call(func() string { return str(o.tab(id), "title") }); curTitle != "Custom Tab Name" {
		t.Fatalf("post-turn title overwrote manual rename: got %q, want Custom Tab Name", curTitle)
	}
}

func TestAntigravityCompliancePolicies(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	cli.ClearLocalAuthCache("")
	t.Cleanup(func() { cli.ClearLocalAuthCache("") })

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)
	rpcLog := filepath.Join(tmp, "compliance-rpc.log")

	mockJS := filepath.Join(tmp, "mock-agy-compliance.js")
	jsSrc := `'use strict';
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  fs.appendFileSync(process.env.MOCK_AGY_RPC_LOG, s + '\n', 'utf8');
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  const notify = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-comp-1', update } }) + '\n');
  if (m.method === 'initialize') {
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }
    });
  } else if (m.method === 'session/new') {
    reply({ sessionId: 's-comp-1', modes: { currentModeId: 'default' } });
  } else if (m.method === 'session/set_mode') {
    reply({});
  } else if (m.method === 'session/prompt') {
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    reply({ stopReason: 'end_turn' });
  } else if (m.method === 'session/close') {
    reply({});
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("MOCK_AGY_RPC_LOG", rpcLog)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	throws := func(label string, fn func()) {
		t.Helper()
		defer func() {
			if recover() == nil {
				t.Fatalf("%s: expected panic, got none", label)
			}
		}()
		fn()
	}

	// 1. CreateTab rejects delegation / subagentOf for antigravity
	throws("CreateTab delegation", func() {
		jsrt.Run(func() {
			o.CreateTab(util.NewObj(
				"backend", "antigravity",
				"delegation", util.NewObj("via", "delegate"),
				"activate", false,
			))
		})
	})
	throws("CreateTab subagentOf", func() {
		jsrt.Run(func() {
			o.CreateTab(util.NewObj(
				"backend", "antigravity",
				"subagentOf", util.NewObj("parentTabId", "main"),
				"activate", false,
			))
		})
	})
	throws("CreateTab seeded messages without cliSessionId", func() {
		jsrt.Run(func() {
			o.CreateTab(util.NewObj(
				"backend", "antigravity",
				"messages", []any{util.NewObj("id", "m1", "role", "user", "content", "copied")},
				"activate", false,
			))
		})
	})

	// 2. SetTabBackend bidirectionally forbids switching into or out of antigravity
	claudeTab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "claude", "activate", false))
	})
	throws("SetTabBackend claude->antigravity", func() {
		jsrt.Run(func() { o.SetTabBackend(str(claudeTab, "id"), "antigravity") })
	})
	agyTab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
	})
	agyTabID := str(agyTab, "id")
	if gotMode := str(agyTab, "permissionMode"); gotMode != "manual" {
		t.Fatalf("antigravity default permissionMode = %q, want manual", gotMode)
	}
	throws("SeedTabMessages antigravity without cliSessionId", func() {
		jsrt.Run(func() {
			o.SeedTabMessages(agyTabID, []any{util.NewObj("id", "m1", "role", "user", "content", "copied")})
		})
	})
	throws("SetTabBackend antigravity->claude", func() {
		jsrt.Run(func() { o.SetTabBackend(agyTabID, "claude") })
	})

	// 2b. prewarm must NOT spawn agy acp or send session/new before any user prompt
	oPre := New(Deps{
		Root:             filepath.Join(tmp, "harness-prewarm"),
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
		PrewarmClaude:    true,
	})
	preTab := jsrt.Call(func() *util.Obj {
		return oPre.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", true))
	})
	jsrt.Run(func() { oPre.prewarm(str(preTab, "id")) })
	time.Sleep(50 * time.Millisecond)
	jsrt.Run(oPre.Dispose)
	if rawPre, _ := os.ReadFile(rpcLog); len(rawPre) > 0 {
		t.Fatalf("prewarm must not spawn antigravity ACP before user input, got:\n%s", string(rawPre))
	}

	// 3. Sandbox spec disabled & carried context ignored
	jsrt.Run(func() {
		tab := o.tab(agyTabID)
		if spec := o.sandboxSpec(tab, work, util.NewObj()); spec != nil {
			t.Fatalf("sandboxSpec(antigravity) = %v, want nil", spec)
		}
		o.setCarried(tab, []*util.Obj{util.NewObj("role", "user", "text", "prior")}, "claude")
		if o.carriedText(agyTabID) != nil {
			t.Fatalf("carriedText(antigravity) = %v, want nil", o.carriedText(agyTabID))
		}
		if o.withSandboxNote(tab, "antigravity", "exact user text") != "exact user text" {
			t.Fatal("withSandboxNote modified antigravity prompt")
		}
	})

	// 4. Send verbatim prompt, check initialize clientInfo/capabilities, mcpServers:[], and auth cache
	exactPrompt := "Please inspect main.go verbatim."
	awaitSend(t, o, agyTabID, exactPrompt)
	if !cli.DetectLocalLogin("antigravity", "") {
		t.Fatal("DetectLocalLogin(\"antigravity\", \"\") should be true after successful ACP session")
	}

	// 5. Explicit session/close on teardownAcpLive when peer advertises sessionCapabilities.close
	jsrt.Run(func() {
		o.teardownAcpLive(agyTabID)
	})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(rpcLog)
		if strings.Contains(string(raw), `"method":"session/close"`) {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	raw, err := os.ReadFile(rpcLog)
	if err != nil {
		t.Fatal(err)
	}
	var sawInit, sawNew, sawPrompt, sawClose bool
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var msg map[string]any
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		params, _ := msg["params"].(map[string]any)
		switch msg["method"] {
		case "initialize":
			sawInit = true
			ci, _ := params["clientInfo"].(map[string]any)
			if ci == nil || ci["name"] != "nomi" {
				t.Fatalf("initialize missing clientInfo.name=nomi: %s", line)
			}
			cc, _ := params["clientCapabilities"].(map[string]any)
			if cc == nil || cc["terminal"] != false {
				t.Fatalf("initialize missing clientCapabilities.terminal=false: %s", line)
			}
			if _, hasElic := cc["elicitation"]; hasElic {
				t.Fatalf("antigravity initialize must not advertise elicitation draft capability: %s", line)
			}
		case "session/new":
			sawNew = true
			mcp, _ := params["mcpServers"].([]any)
			if len(mcp) != 0 {
				t.Fatalf("antigravity session/new mcpServers must be empty, got %v", mcp)
			}
		case "session/prompt":
			sawPrompt = true
			blocks, _ := params["prompt"].([]any)
			if len(blocks) != 1 {
				t.Fatalf("expected 1 verbatim prompt block, got %v", blocks)
			}
			b0, _ := blocks[0].(map[string]any)
			if b0["text"] != exactPrompt {
				t.Fatalf("session/prompt text = %q, want exact %q", b0["text"], exactPrompt)
			}
		case "session/close":
			sawClose = true
		}
	}
	if !sawInit || !sawNew || !sawPrompt || !sawClose {
		t.Fatalf("missing expected ACP RPC methods (init=%v new=%v prompt=%v close=%v):\n%s", sawInit, sawNew, sawPrompt, sawClose, string(raw))
	}
}

func TestAntigravityPlanUpdateMergedInTrace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)

	mockJS := filepath.Join(tmp, "mock-agy-plan.js")
	jsSrc := `'use strict';
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  const notify = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-plan-1', update } }) + '\n');
  if (m.method === 'initialize') {
    reply({ protocolVersion: 1 });
  } else if (m.method === 'session/new') {
    reply({ sessionId: 's-plan-1', modes: { currentModeId: 'default' } });
  } else if (m.method === 'session/set_mode' || m.method === 'session/close') {
    reply({});
  } else if (m.method === 'session/prompt') {
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working...' } });
    notify({
      sessionUpdate: 'plan',
      planId: 'p1',
      entries: [
        { content: 'Audit slides', status: 'in_progress', priority: 'high' },
        { content: 'Run browser check', status: 'pending' }
      ]
    });
    notify({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'read', title: 'Read file', status: 'completed' });
    notify({
      sessionUpdate: 'plan',
      planId: 'p1',
      entries: [
        { content: 'Audit slides', status: 'completed', priority: 'high' },
        { content: 'Run browser check', status: 'in_progress' }
      ]
    });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } });
    reply({ stopReason: 'end_turn' });
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
	})
	id := str(tab, "id")
	awaitSend(t, o, id, "build slides")

	msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	last := msgs[len(msgs)-1]
	trace := evs(last.Get("trace"))
	if len(trace) != 2 {
		t.Fatalf("len(trace) = %d, want 2 (%v)", len(trace), trace)
	}
	p0 := trace[0]
	if p0 == nil || p0.Get("type") != "plan" || p0.Get("planId") != "p1" {
		t.Fatalf("trace[0] = %v", trace[0])
	}
	if p0.Get("textAt") != float64(len("Working...")) {
		t.Fatalf("plan textAt = %v, want %d", p0.Get("textAt"), len("Working..."))
	}
	entries, _ := p0.Get("entries").([]any)
	if len(entries) != 2 || util.AsObj(entries[0]).Get("status") != "completed" || util.AsObj(entries[1]).Get("status") != "in_progress" {
		t.Fatalf("merged plan entries = %v", entries)
	}
}

func TestAntigravityCommandsPlanRemovedAndListSessions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node required on PATH")
	}
	if r, err := filepath.EvalSymlinks(node); err == nil {
		node = r
	}

	tmp, _ := filepath.EvalSymlinks(t.TempDir())
	binDir := filepath.Join(tmp, ".local", "bin")
	agyCliDir := filepath.Join(tmp, ".gemini", "antigravity-cli")
	_ = os.MkdirAll(binDir, 0o755)
	_ = os.MkdirAll(agyCliDir, 0o700)

	mockJS := filepath.Join(tmp, "mock-agy-ext.js")
	jsSrc := `'use strict';
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let m; try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return;
  const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: res }) + '\n');
  const notify = (update) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-ext-1', update } }) + '\n');
  if (m.method === 'initialize') {
    reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, list: {} } } });
  } else if (m.method === 'session/new') {
    reply({ sessionId: 's-ext-1', modes: { currentModeId: 'default' } });
    notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'audit', description: 'Run audit', input: { hint: '[path]' } }] });
  } else if (m.method === 'session/list') {
    reply({ sessions: [{ sessionId: 's-hist-1', title: 'Prior Session', cwd: '/tmp' }] });
  } else if (m.method === 'session/set_mode' || m.method === 'session/close') {
    reply({});
  } else if (m.method === 'session/prompt') {
    notify({ sessionUpdate: 'plan', planId: 'p-drop', entries: [{ content: 'Temp', status: 'in_progress' }] });
    notify({ sessionUpdate: 'plan_removed', planId: 'p-drop' });
    notify({ sessionUpdate: 'subagent_update', subagentId: 'sa-1', label: 'Worker', status: 'running' });
    notify({ sessionUpdate: 'subagent_update', subagentId: 'sa-1', status: 'completed', summary: 'Done' });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
    reply({ stopReason: 'end_turn' });
  }
});
`
	if err := os.WriteFile(mockJS, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	agyBin := filepath.Join(binDir, "agy")
	if err := os.WriteFile(agyBin, []byte("#!/bin/sh\nexec \""+node+"\" \""+mockJS+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("NOMI_USE_MOCK_CLI", "")
	t.Setenv("HOME", tmp)
	t.Setenv("ANTIGRAVITY_CLI_HOME", agyCliDir)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	cli.ResetCliBinCache()
	t.Cleanup(cli.ResetCliBinCache)

	root := filepath.Join(tmp, "harness")
	work := filepath.Join(tmp, "docs", "nomi")
	_ = os.MkdirAll(root, 0o755)
	_ = os.MkdirAll(work, 0o755)
	idle := 0.0
	o := New(Deps{
		Root:             root,
		Home:             tmp,
		DefaultCwd:       work,
		LegacyDefaultCwd: filepath.Join(tmp, "docs"),
		Logger:           nopLogger{},
		Ports:            nopPorts{},
		IdleReclaimMs:    &idle,
	})
	defer jsrt.Run(o.Dispose)

	tab := jsrt.Call(func() *util.Obj {
		return o.CreateTab(util.NewObj("backend", "antigravity", "source", "local", "activate", false))
	})
	id := str(tab, "id")
	awaitSend(t, o, id, "check features")

	cmds := jsrt.Call(func() []any { return o.TabCommands(id) })
	if len(cmds) != 1 || util.AsObj(cmds[0]) == nil || util.AsObj(cmds[0]).Get("name") != "audit" || util.AsObj(cmds[0]).Get("hint") != "[path]" {
		t.Fatalf("TabCommands = %v", cmds)
	}

	msgs := jsrt.Call(func() []*util.Obj { return o.TabMessages(id) })
	last := msgs[len(msgs)-1]
	trace := evs(last.Get("trace"))
	for _, ev := range trace {
		if ev.Get("type") == "plan" {
			t.Fatalf("plan-removed should have removed p-drop from final trace: %v", trace)
		}
	}

	listed, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] {
		return o.ListAcpSessions("antigravity", work, "")
	}))
	if err != nil {
		t.Fatalf("ListAcpSessions: %v", err)
	}
	sessions, _ := listed.Get("sessions").([]any)
	if len(sessions) != 1 || util.AsObj(sessions[0]).Get("sessionId") != "s-hist-1" {
		t.Fatalf("ListAcpSessions = %v", listed)
	}
}
