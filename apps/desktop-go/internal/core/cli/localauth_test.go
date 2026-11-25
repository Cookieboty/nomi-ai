package cli

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func writeMockAgyBinary(t *testing.T) (binPath, stateFile, rpcLogFile string) {
	t.Helper()
	dir := t.TempDir()
	node := findNode(t)
	stateFile = filepath.Join(dir, "state.json")
	rpcLogFile = filepath.Join(dir, "rpc.log")
	jsFile := filepath.Join(dir, "mock-agy.js")
	binPath = filepath.Join(dir, "agy")

	jsSrc := `'use strict';
const fs = require('fs');
const readline = require('readline');

const stateFile = process.env.MOCK_AGY_STATE;
const rpcLog = process.env.MOCK_AGY_RPC_LOG;
const args = process.argv.slice(2);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { loggedIn: false, loginMode: 'ok' };
  }
}
function writeState(next) {
  fs.writeFileSync(stateFile, JSON.stringify(next), 'utf8');
}

if (args.includes('--login')) {
  const st = readState();
  if (st.loginMode === 'blocked') {
    process.stderr.write('request failed with status 403 Forbidden\n');
    process.exit(1);
  }
  if (st.loginMode === 'hang') {
    process.stdout.write('Visit https://accounts.google.com/o/oauth2/auth?hang=1\n');
    setInterval(() => {}, 10000);
  } else {
    process.stdout.write('\x1b[32mOpen https://accounts.google.com/o/oauth2/auth?client=mock-agy to sign in\x1b[0m\n');
    setTimeout(() => {
      st.loggedIn = true;
      writeState(st);
      process.exit(0);
    }, 30);
  }
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (rpcLog) fs.appendFileSync(rpcLog, trimmed + '\n', 'utf8');
    if (msg.id === undefined || msg.id === null) return;
    const reply = (res) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: res }) + '\n');
    const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, auth: { logout: {} } });
    } else if (msg.method === 'session/new') {
      const st = readState();
      if (!st.loggedIn) {
        fail(-32000, 'Authentication required');
      } else {
        reply({ sessionId: 's-local-1' });
      }
    } else if (msg.method === 'session/close') {
      reply({});
    } else if (msg.method === 'logout') {
      const st = readState();
      st.loggedIn = false;
      writeState(st);
      reply({});
    } else {
      fail(-32601, 'Method not found');
    }
  });
}
`
	if err := os.WriteFile(jsFile, []byte(jsSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	wrapper := "#!/bin/sh\nexec \"" + node + "\" \"" + jsFile + "\" \"$@\"\n"
	if err := os.WriteFile(binPath, []byte(wrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	return binPath, stateFile, rpcLogFile
}

func waitUntil(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if jsrt.Call(fn) {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}

func TestLocalAuthServiceProbeLoginCancelLogoutAndCache(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell mock required")
	}
	ClearLocalAuthCache("")
	t.Cleanup(func() { ClearLocalAuthCache("") })

	binPath, stateFile, rpcLog := writeMockAgyBinary(t)
	t.Setenv("MOCK_AGY_STATE", stateFile)
	t.Setenv("MOCK_AGY_RPC_LOG", rpcLog)
	_ = os.WriteFile(stateFile, []byte(`{"loggedIn":false,"loginMode":"ok"}`), 0o600)

	var events []*util.Obj
	var changed []string
	var binOverride string
	binOverride = binPath

	svc := NewLocalAuthService(LocalAuthDeps{
		ResolveBin: func(kind string) string {
			if kind == "antigravity" {
				return binOverride
			}
			return ""
		},
		Emit:      func(e *util.Obj) { events = append(events, e) },
		OnChanged: func(kind string) { changed = append(changed, kind) },
		TimeoutMs: 5_000,
		ProbeMs:   5_000,
	})
	defer jsrt.Run(svc.Dispose)

	// 1. Unsupported kind & missing binary
	unsupported, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.Status("dsh", true) }))
	if err != nil || unsupported.Get("canLogin") != false || unsupported.Get("canLogout") != false {
		t.Fatalf("unsupported status = %s, err=%v", util.Stringify(unsupported), err)
	}
	binOverride = ""
	missing, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.Status("antigravity", true) }))
	if err != nil || missing.Get("canLogin") != false || !util.Truthy(missing.Get("detail")) {
		t.Fatalf("missing bin status = %s, err=%v", util.Stringify(missing), err)
	}
	binOverride = binPath

	// 2. Real ACP probe detects signed-out (-32000 Authentication required) and populates cache
	st0, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.Status("antigravity", true) }))
	if err != nil || st0.Get("loggedIn") != false || st0.Get("canLogin") != true || st0.Get("canLogout") != true {
		t.Fatalf("signed-out probe = %s, err=%v", util.Stringify(st0), err)
	}
	if cached, ok := CachedLocalAuth("antigravity"); !ok || cached {
		t.Fatalf("CachedLocalAuth = (%v, %v), want (false, true)", cached, ok)
	}

	// 3. StartLogin launches `acp --login`, extracts Google OAuth URL, verifies, emits done & updates cache
	events = nil
	changed = nil
	initEv, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.StartLogin("antigravity") }))
	if err != nil || initEv.Get("state") != "starting" {
		t.Fatalf("StartLogin initial = %s, err=%v", util.Stringify(initEv), err)
	}
	waitUntil(t, func() bool {
		return len(events) > 0 && events[len(events)-1].Get("state") == "done"
	})
	var states []string
	var sawURL string
	for _, ev := range events {
		states = append(states, util.Str(ev.Get("state")))
		if u := util.Str(ev.Get("url")); u != "" {
			sawURL = u
		}
	}
	if !strings.HasPrefix(sawURL, "https://accounts.google.com/") {
		t.Fatalf("expected Google OAuth URL, got %q (states=%v)", sawURL, states)
	}
	for _, want := range []string{"starting", "waiting", "verifying", "done"} {
		if !slices.Contains(states, want) {
			t.Fatalf("missing login state %q in %v", want, states)
		}
	}
	if !DetectLocalLogin("antigravity", "") {
		t.Fatal("DetectLocalLogin(\"antigravity\", \"\") = false after verified login")
	}
	if lv := LaunchersView()["antigravity"]; !lv.HasLocalLogin {
		t.Fatalf("LaunchersView()[antigravity].HasLocalLogin = false, want true")
	}
	if len(changed) == 0 {
		t.Fatal("expected OnChanged after successful login")
	}

	// 4. Logout sends ACP "logout" (not "auth/logout") and clears cache to false
	_ = os.WriteFile(rpcLog, nil, 0o600)
	changed = nil
	lo, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.Logout("antigravity") }))
	if err != nil || lo.Get("loggedIn") != false {
		t.Fatalf("Logout = %s, err=%v", util.Stringify(lo), err)
	}
	rawRPC, _ := os.ReadFile(rpcLog)
	if !strings.Contains(string(rawRPC), `"method":"logout"`) || strings.Contains(string(rawRPC), `"auth/logout"`) {
		t.Fatalf("unexpected logout RPC payload:\n%s", string(rawRPC))
	}
	if DetectLocalLogin("antigravity", "") {
		t.Fatal("DetectLocalLogin must return false after Logout")
	}
	if !slices.Contains(changed, "antigravity") {
		t.Fatalf("OnChanged after Logout = %v", changed)
	}

	// 5. 403 error sets hint=network-blocked
	events = nil
	_ = os.WriteFile(stateFile, []byte(`{"loggedIn":false,"loginMode":"blocked"}`), 0o600)
	if _, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.StartLogin("antigravity") })); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool {
		return len(events) > 0 && events[len(events)-1].Get("state") == "error"
	})
	if last := events[len(events)-1]; last.Get("hint") != "network-blocked" {
		t.Fatalf("expected network-blocked hint on 403, got %s", util.Stringify(last))
	}

	// 6. CancelLogin aborts hanging session
	events = nil
	_ = os.WriteFile(stateFile, []byte(`{"loggedIn":false,"loginMode":"hang"}`), 0o600)
	hangEv, err := jsrt.Block(jsrt.Call(func() *jsrt.Promise[*util.Obj] { return svc.StartLogin("antigravity") }))
	if err != nil {
		t.Fatal(err)
	}
	hangID := util.Str(hangEv.Get("id"))
	waitUntil(t, func() bool {
		return len(events) >= 2 && events[len(events)-1].Get("state") == "waiting"
	})
	if ok := jsrt.Call(func() bool { return svc.CancelLogin(hangID) }); !ok {
		t.Fatal("CancelLogin returned false")
	}
	if last := events[len(events)-1]; last.Get("state") != "cancelled" {
		t.Fatalf("expected cancelled state, got %s", util.Stringify(last))
	}
}

func TestAntigravityJetskiStateDetection(t *testing.T) {
	home := t.TempDir()
	agyDir := filepath.Join(home, ".gemini", "antigravity")
	if err := os.MkdirAll(agyDir, 0o700); err != nil {
		t.Fatal(err)
	}
	pb := filepath.Join(agyDir, "jetski_state.pbtxt")
	if err := os.WriteFile(pb, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if DetectLocalLogin("antigravity", home) {
		t.Fatal("whitespace-only jetski_state.pbtxt must not count as logged in")
	}
	if err := os.WriteFile(pb, []byte("active_user: \"u@example.com\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !DetectLocalLogin("antigravity", home) {
		t.Fatal("non-empty jetski_state.pbtxt should detect local login")
	}
}
