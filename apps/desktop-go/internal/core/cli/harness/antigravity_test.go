package harness

import (
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
	_ = os.WriteFile(filepath.Join(agyCliDir, "oauth_creds.json"), []byte(`{"token":"ok"}`), 0o600)
	_ = os.WriteFile(filepath.Join(agyCliDir, "settings.json"), []byte(`{"model":"gemini-4-neon-xhigh"}`), 0o600)

	mockJS := filepath.Join(tmp, "mock-agy.js")
	jsSrc := `'use strict';
const readline = require('readline');
if (process.argv.slice(2)[0] === 'models') {
  process.stdout.write([
    '  auto                           Auto',
    '  gemini-4-neon-low              Gemini 4 Neon (Low)',
    '  gemini-4-neon-xhigh            Gemini 4 Neon (Extra High)',
    '  gpt-oss-120b-medium            GPT-OSS 120B (Medium)'
  ].join('\n') + '\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
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
          { modelId: 'gemini-pro-orchestrator-neon', name: 'Gemini Pro Orchestrator Neon' },
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
	_ = os.WriteFile(filepath.Join(agyCliDir, "oauth_creds.json"), []byte(`{"token":"ok"}`), 0o600)

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
	_ = os.WriteFile(filepath.Join(agyCliDir, "oauth_creds.json"), []byte(`{"token":"ok"}`), 0o600)

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
