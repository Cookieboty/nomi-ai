package shellhandlers_test

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/mainchat/codexrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// This is ONLY a fake JSON-RPC app-server. It never reads credentials, never
// touches the network and never launches a paid model. It speaks the official
// initialize / thread/* / turn/* frames the driver already uses.
const fakeCodexScript = `import json, os, sys, time
root = os.path.dirname(os.path.realpath(__file__))

def log(kind, data):
    with open(os.path.join(root, "wire.jsonl"), "a") as f:
        f.write(json.dumps({"kind": kind, "data": data}) + "\n")

def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()

mode = open(os.path.join(root, "mode")).read().strip()
pid = os.getpid()
# Own argv/cwd plus presence booleans only: never read or journal any secret value.
log("launch", {"pid": pid, "pgid": os.getpgid(0), "args": sys.argv[1:], "cwd": os.getcwd(),
               "codex_home": os.environ.get("CODEX_HOME"),
               "openai_api_key": "OPENAI_API_KEY" in os.environ,
               "codex_api_key": "CODEX_API_KEY" in os.environ,
               "openai_base_url": "OPENAI_BASE_URL" in os.environ})
if mode == "startup-error":
    out({"id": 1, "error": {"code": -32000, "message": "startup exploded"}})
    time.sleep(0.2)
    sys.exit(17)
counter = [0]
pending_approval = [False]

def thread_id(params):
    return (params or {}).get("threadId")

def text_of(params):
    parts = []
    for item in (params or {}).get("input") or []:
        if isinstance(item, dict):
            parts.append(item.get("text") or "")
    return "\n".join(parts)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    mid, method, params = m.get("id"), m.get("method"), m.get("params")
    log("recv", m)
    if method == "initialize":
        if mode == "init-error":
            out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": "initialize refused"}})
            continue
        out({"jsonrpc": "2.0", "id": mid, "result": {"userAgent": "fake-codex/0"}})
    elif method == "initialized":
        pass
    elif method == "thread/resume":
        tid = thread_id(params)
        if mode in ("missing", "missing-start-error"):
            out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32600, "message": "thread not found"}})
        elif mode == "other":
            out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32600, "message": "thread not found: no rollout"}})
        elif mode == "empty":
            out({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mode == "wrong":
            out({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "different-thread"}}})
        elif mode == "hang":
            # Never answer thread/resume: the runtime request carries the
            # official 120s deadline and the product cancellation/default
            # fd-read timeout must terminate it. Keep serving stdin so the
            # process stays alive until the product stops it.
            log("resume-pending", {"id": mid})
            continue
        else:
            out({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": tid}}})
    elif method == "thread/start":
        if mode in ("start-error", "missing-start-error"):
            out({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": "thread/start refused"}})
            continue
        counter[0] += 1
        out({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "thread-%d-%d" % (pid, counter[0])}}})
    elif method == "turn/start":
        tid = thread_id(params)
        turn = "turn-%d-%d" % (pid, counter[0])
        out({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": turn}}})
        out({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": tid, "turn": {"id": turn, "status": "inProgress"}}})
        if mode == "approval":
            out({"jsonrpc": "2.0", "method": "item/started", "params": {"threadId": tid, "turnId": turn, "item": {
                "id": "cmd1", "type": "commandExecution", "command": "echo fixture", "status": "inProgress"}}})
            out({"jsonrpc": "2.0", "id": "srv-approval", "method": "item/commandExecution/requestApproval",
                 "params": {"threadId": tid, "turnId": turn, "itemId": "cmd1", "reason": "fixture"}})
            pending_approval[0] = (tid, turn)
            continue
        if mode == "hang":
            out({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": tid, "turnId": turn, "itemId": "m", "delta": "LATE_UNCOMMITTED"}})
            continue
        if mode == "failed":
            out({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": tid, "turnId": turn, "itemId": "m", "delta": "partial before failure"}})
            out({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": tid, "turn": {"id": turn, "status": "failed", "error": {"message": "fixture failure"}}}})
            continue
        text = "native reply " + str(counter[0])
        out({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": tid, "turnId": turn, "itemId": "m", "delta": text}})
        out({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": tid, "turnId": turn, "itemId": "m", "item": {
            "id": "m", "type": "agentMessage", "text": text}}})
        out({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": tid, "turn": {"id": turn, "status": "completed"}}})
    elif method is None and "result" in m and pending_approval[0]:
        tid, turn = pending_approval[0]
        pending_approval[0] = False
        dec = (m.get("result") or {}).get("decision") or "decline"
        text = "native " + dec
        out({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": tid, "turnId": turn, "item": {
            "id": "cmd1", "type": "commandExecution", "command": "echo fixture", "status": "completed"}}})
        out({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": tid, "turnId": turn, "itemId": "m", "delta": text}})
        out({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": tid, "turn": {"id": turn, "status": "completed"}}})
    elif mid is not None:
        out({"jsonrpc": "2.0", "id": mid, "result": {}})
`

type codexFixture struct {
	dir  string
	proj *projects.Store
}

func (x *codexFixture) setMode(t *testing.T, mode string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(x.dir, "mode"), []byte(mode), 0o600); err != nil {
		t.Fatal(err)
	}
}

// codexIngress wires the real main-chat ingress (Registry, typed IPC, leased
// Session, convstore S1) to a fake official Codex app-server and a fake API
// backend, with one selected project for conversation "c".
func codexIngress(t *testing.T, mode string) (*codexFixture, *convstore.Store, *mainchat.Registry, *convSession) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX #!/bin/sh launcher fixture requires Unix")
	}
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable for the fake app-server")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake_appserver.py")
	if err := os.WriteFile(script, []byte(fakeCodexScript), 0o700); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "codex")
	launcher := "#!/bin/sh\nexec " + py + " " + script + " \"$@\"\n"
	if err := os.WriteFile(exe, []byte(launcher), 0o700); err != nil {
		t.Fatal(err)
	}
	project, config := filepath.Join(dir, "project"), filepath.Join(dir, "codex-home")
	for _, d := range []string{project, config} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	x := &codexFixture{dir: dir}
	x.setMode(t, mode)
	store, r, c := fixtureIngress(t, filepath.Join(dir, "store"))
	f := codexrt.New(func(convID string) (codexrt.Config, error) {
		return codexrt.Config{
			Executable:     exe,
			Cwd:            project,
			ConfigDir:      config,
			PermissionMode: r.ConfigFor(convID, "codex").PermissionMode,
		}, nil
	})
	r.RegisterOwned("codex", f.Target, f.Release)
	r.Register("api", (&ingressFake{name: "api"}).target)
	projs := codexProjectStore(dir)
	x.proj = projs
	p, err := projs.Create("fixture", project, nil)
	if err != nil {
		t.Fatal(err)
	}
	seedCodexConversation(t, c, p.ID)
	return x, store, r, c
}

// codexProjectStore mirrors main.go's migrationStore deps (stat + symlink
// check, inside-relation, fixed clock) without depending on package main.
func codexProjectStore(userData string) *projects.Store {
	return projects.New(projects.Deps{
		File: filepath.Join(userData, "projects.json"),
		Check: func(d string) (string, string) {
			if st, err := os.Stat(d); err != nil || !st.IsDir() {
				return "", "missing"
			}
			r, _ := filepath.EvalSymlinks(d)
			return r, ""
		},
		Inside: func(c, p string) bool {
			r, err := filepath.Rel(p, c)
			return err == nil && filepath.IsLocal(r) || r == "."
		},
		Now: func() int64 { return 1 },
	})
}

// codexIngressWithWiring wires the production main.go registration path after
// a conversation has been seeded through IPC.
func codexIngressWithWiring(t *testing.T, mode string) (*convstore.Store, *mainchat.Registry, *convSession, string) {
	t.Helper()
	_, store, r, c := codexIngress(t, mode)
	return store, r, c, ""
}

func seedCodexConversation(t *testing.T, c *convSession, projectID string) {
	t.Helper()
	meta, _ := json.Marshal(map[string]any{"id": "c", "backend": "nomi", "name": "same sidebar", "projectId": projectID})
	input, _ := json.Marshal(map[string]any{"meta": json.RawMessage(meta), "messages": []any{
		map[string]any{"id": "seed", "role": "user", "content": "retained API history", "timestamp": 1},
	}})
	requireOK(t, c.call("conversations.put", string(input)))
}

func awaitCodex(t *testing.T, c *convSession, phase cr.Phase) nativeView {
	return awaitClaude(t, c, phase)
}

func codexWire(t *testing.T, dir string) []claudeWire {
	return readClaudeWire(t, dir)
}

// launchRecord is one launch journaled by the fake app-server itself: its own
// argv, cwd, config dir and credential-presence booleans (never values).
type launchRecord struct {
	Args        []string
	Cwd         string
	CodexHome   string `json:"codex_home"`
	OpenAIKey   bool   `json:"openai_api_key"`
	CodexAPIKey bool   `json:"codex_api_key"`
	OpenAIURL   bool   `json:"openai_base_url"`
}

func codexLaunches(t *testing.T, dir string) []launchRecord {
	t.Helper()
	var out []launchRecord
	for _, e := range codexWire(t, dir) {
		if e.Kind == "launch" {
			var rec launchRecord
			if json.Unmarshal(e.Data, &rec) != nil {
				t.Fatalf("invalid launch journal: %s", e.Data)
			}
			out = append(out, rec)
		}
	}
	return out
}

func TestCodexOfficialSubprocessActualIPCClaudeAPICodexFullDelta(t *testing.T) {
	x, store, r, c := codexIngress(t, "success")
	// Claude joins the same ingress as a second official backend (fake script).
	cf, _ := claudeFixture(t, "success")
	r.RegisterOwned("claude", cf.Target, cf.Release)
	t.Setenv("OPENAI_API_KEY", "FAKE_MUST_BE_STRIPPED")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	if st := awaitCodex(t, c, cr.PhaseCompleted); st.Recovery != cr.RecoveryNew {
		t.Fatalf("first Codex turn must open a new native thread: %+v", st)
	}
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"api"}`))
	requireOK(t, sendIngress(t, c, "two"))
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"claude"}`))
	requireOK(t, sendIngress(t, c, "three"))
	awaitClaude(t, c, cr.PhaseCompleted)
	requireOK(t, c.call("conversations.runtimeSelect", `{"id":"c","backend":"codex"}`))
	requireOK(t, sendIngress(t, c, "four"))
	last := awaitCodex(t, c, cr.PhaseCompleted)
	if last.Recovery != cr.RecoveryResumed {
		t.Fatalf("warm Codex binding lost across API/Claude switches: %+v", last)
	}
	records := codexLaunches(t, x.dir)
	if len(records) != 1 {
		t.Fatalf("warm Codex process relaunched: %d launches", len(records))
	}
	rec := records[0]
	want := []string{
		"-c", "analytics.enabled=false",
		"-c", `cli_auth_credentials_store="file"`,
		"-c", `sandbox_mode="workspace-write"`,
		"-c", "sandbox_workspace_write.network_access=true",
		"-c", `approval_policy="on-request"`,
		"-c", `approvals_reviewer="auto_review"`,
		"app-server",
	}
	if strings.Join(rec.Args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("official auto argv changed: %q, want %q", rec.Args, want)
	}
	for _, banned := range []string{"-s", "-a", "danger-full-access", "read-only", "--bare", "computer", "exec"} {
		if slices.Contains(rec.Args, banned) {
			t.Fatalf("forbidden flag %q in %q", banned, rec.Args)
		}
	}
	// The native cwd must be exactly the selected project, compared physically:
	// macOS reports /private/var for the /var TMPDIR the project was created in.
	physical := func(p string) string {
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return p
	}
	if physical(rec.Cwd) != physical(filepath.Join(x.dir, "project")) {
		t.Fatalf("project cwd isolation: %q", rec.Cwd)
	}
	if rec.OpenAIKey || rec.CodexAPIKey || rec.OpenAIURL {
		t.Fatalf("credential/endpoint overrides inherited by official Codex: %+v", rec)
	}
	if rec.CodexHome != filepath.Join(x.dir, "codex-home") {
		t.Fatalf("CODEX_HOME = %q", rec.CodexHome)
	}
	users := 0
	for _, e := range codexWire(t, x.dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		params, _ := m["params"].(map[string]any)
		if e.Kind != "recv" || m["method"] != "turn/start" || params == nil {
			continue
		}
		users++
		payload := fmt.Sprint(params["input"])
		if users == 1 {
			if !strings.Contains(payload, "retained API history") || !strings.Contains(payload, "request one") {
				t.Fatalf("first Codex turn is not a full request: %q", payload)
			}
		} else if strings.Contains(payload, "request one") || !strings.Contains(payload, "request two") || !strings.Contains(payload, "request three") || strings.Count(payload, "request four") != 1 {
			t.Fatalf("warm Codex turn reused stale delta or duplicated the current request: %q", payload)
		}
	}
	if messages, err := store.Messages("c", 0); err != nil || len(messages) != 9 {
		t.Fatalf("product transcript lost: %d %v", len(messages), err)
	}
}

func TestCodexOfficialSubprocessResumeMissingFallsBackPreservingBinding(t *testing.T) {
	x, store, _, c := codexIngress(t, "success")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitCodex(t, c, cr.PhaseCompleted)
	first, err := store.ReadManaged("c")
	if err != nil || len(first.State.Bindings) != 1 {
		t.Fatal("first binding", err)
	}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	x.setMode(t, "missing")
	requireOK(t, sendIngress(t, c, "two"))
	st := awaitCodex(t, c, cr.PhaseCompleted)
	if st.Recovery != cr.RecoveryFallback {
		t.Fatalf("exact \"thread not found\" must be proven fallback: %+v", st)
	}
	doc, err := store.ReadManaged("c")
	if err != nil || len(doc.State.Bindings) != 2 {
		t.Fatalf("fallback bindings: %+v %v", doc.State.Bindings, err)
	}
	var oldKept bool
	for _, b := range doc.State.Bindings {
		if b.NativeSessionID == first.State.Bindings[0].NativeSessionID && b.Status == cr.StatusStale {
			oldKept = true
		}
	}
	if !oldKept {
		t.Fatalf("old binding not preserved: %+v", doc.State.Bindings)
	}
	resumes, starts, turns := 0, 0, []string{}
	for _, e := range codexWire(t, x.dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind != "recv" {
			continue
		}
		switch m["method"] {
		case "thread/resume":
			resumes++
		case "thread/start":
			starts++
		case "turn/start":
			turns = append(turns, fmt.Sprint(m["params"].(map[string]any)["input"]))
		}
	}
	if resumes != 1 || starts != 2 || len(turns) != 2 || !strings.Contains(turns[1], "retained API history") || !strings.Contains(turns[1], "request one") || strings.Count(turns[1], "request two") != 1 {
		t.Fatalf("fallback payload/thread calls wrong: resumes=%d starts=%d turns=%q", resumes, starts, turns)
	}
}

// codexSentMethod reports whether the fake app-server journaled receipt of
// the given JSON-RPC method (proof it actually reached the native side).
func codexSentMethod(t *testing.T, dir, method string) bool {
	t.Helper()
	for _, e := range codexWire(t, dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind == "recv" && m["method"] == method {
			return true
		}
	}
	return false
}

func codexKind(t *testing.T, dir, kind string) bool {
	t.Helper()
	for _, e := range codexWire(t, dir) {
		if e.Kind == kind {
			return true
		}
	}
	return false
}

func codexCount(t *testing.T, dir, method string) int {
	t.Helper()
	n := 0
	for _, e := range codexWire(t, dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind == "recv" && m["method"] == method {
			n++
		}
	}
	return n
}

// codexLaunchesAfter counts launches journaled after the first receipt of
// the given method (the cold process is spawned before its resume frame).
func codexTotalLaunches(t *testing.T, dir string) int {
	t.Helper()
	n := 0
	for _, e := range codexWire(t, dir) {
		if e.Kind == "launch" {
			n++
		}
	}
	return n
}

func codexLaunchesAfter(t *testing.T, dir, method string) int {
	t.Helper()
	seen, n := false, 0
	for _, e := range codexWire(t, dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		switch {
		case e.Kind == "recv" && m["method"] == method:
			seen = true
		case e.Kind == "launch" && seen:
			n++
		}
	}
	return n
}

func TestCodexOfficialSubprocessUnprovenResumesStayUnknown(t *testing.T) {
	for _, mode := range []string{"other", "empty", "wrong", "hang"} {
		t.Run(mode, func(t *testing.T) {
			x, store, _, c := codexIngress(t, "success")
			requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
			requireOK(t, sendIngress(t, c, "one"))
			awaitCodex(t, c, cr.PhaseCompleted)
			before, err := store.ReadManaged("c")
			if err != nil || len(before.State.Receipts) != 1 || len(before.State.Completed) != 1 {
				t.Fatal("first delivery", err)
			}
			requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
			x.setMode(t, mode)
			if mode == "hang" {
				// Dispatch the cold send as its own correlated IPC request: it
				// stays pending while thread/resume is unanswered (official
				// 120s deadline), so it must NOT be awaited synchronously. Only
				// once the fixture journaled receipt of thread/resume AND the
				// attempt is visibly preparing (foreign frame answered) is the
				// same conversation canceled on this ordered connection.
				g := generation(t, c)
				startsBefore := codexCount(t, x.dir, "thread/start")
				sent := c.request("conversations.runtimeSend", fmt.Sprintf(`{"id":"c","messageId":"cold","turnId":"t_cold","text":"request cold","expectedGeneration":%d}`, g))
				if !c.until(func() bool { return codexSentMethod(t, x.dir, "thread/resume") }) {
					t.Fatal("cold thread/resume never reached the official fixture")
				}
				if f, ok := sent.await(20 * time.Millisecond); ok {
					t.Fatalf("cold send did not stay pending on the unanswered resume: %+v", f)
				}
				start := time.Now()
				// Cancellation stops the native process but proves nothing
				// about the interrupted resume: it must report the unknown
				// state, not a success-shaped cancel.
				if got := sent.c.call("conversations.runtimeCancel", `{"id":"c"}`); got.T != "err" || got.Error == nil || got.Error.Code != "RUNTIME_FAILED" {
					t.Fatalf("cancel during unproven preparation reported the resume as resolved: %+v", got)
				}
				f, ok := sent.await(3 * time.Second)
				if !ok {
					t.Fatal("cancelled cold send never unwound (bounded)")
				}
				if f.T == "res" {
					t.Fatal("unproven cold resumption accepted after cancel")
				}
				if time.Since(start) > 3*time.Second {
					t.Fatal("cancel did not stop the pending resume within bound")
				}
				// A respawned app-server would journal its own launch (and a
				// second resume) after the first resume frame.
				if n := codexLaunchesAfter(t, x.dir, "thread/resume"); n != 0 {
					t.Fatalf("canceled resume spawned another native process: %d launches", n)
				}
				if n := codexCount(t, x.dir, "thread/start"); n != startsBefore {
					t.Fatalf("canceled unproven resume started a new thread: %d starts", n-startsBefore)
				}
				if !codexKind(t, x.dir, "resume-pending") {
					t.Fatal("fixture journal does not prove the resume request was received and left unanswered")
				}
				// Exactly the warm first turn plus one cold process; no respawn.
				if n := codexTotalLaunches(t, x.dir); n != 2 {
					t.Fatalf("canceled resume respawned the native process: %d launches", n)
				}
			}
			// Non-canceled unproven resumes must stay Unknown and demand an
			// explicit new-native decision. The hang case was explicitly
			// canceled by the user with a confirmed process-group stop:
			// Session.finishCancel records PhaseCanceled for proven stop, and
			// the unproven native context is fenced, never certified.
			canceled := mode == "hang"
			var st nativeView
			if !canceled {
				if sendIngress(t, c, "cold").T != "err" {
					t.Fatal("unproven cold resumption accepted")
				}
				st = awaitCodex(t, c, cr.PhaseUncertain)
			} else {
				// A canceled turn is not a safe replay point: the attempt is
				// durably canceled, nothing is queued, and the canceled
				// unknown context still forbids an implicit new send or an
				// unproven resolve until the user decides explicitly.
				st = awaitCodex(t, c, cr.PhaseCanceled)
				if d, err := store.ReadManaged("c"); err != nil || len(d.State.Queue) != 0 || d.State.Active == nil || d.State.Active.Phase != cr.PhaseCanceled || d.State.Active.Recovery.Kind != cr.RecoveryUnknown {
					t.Fatalf("canceled cold send was not durably fenced: %+v %v", d.State, err)
				}
				if got := sendIngress(t, c, "after-proven-cancel"); got.T != "err" {
					t.Fatal("proven cancel certified the unproven native context")
				}
				if got := c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"new-native","confirm":true,"expectedGeneration":%d}`, generation(t, c))); got.T != "err" {
					t.Fatal("canceled unknown recovery was resolved without an explicit unknown decision")
				}
				if got := awaitCodex(t, c, cr.PhaseCanceled); got.Recovery != cr.RecoveryUnknown {
					t.Fatalf("canceled context changed recovery: %+v", got)
				}
			}
			if st.Recovery != cr.RecoveryUnknown {
				t.Fatalf("%s must be RecoveryUnknown: %+v", mode, st)
			}
			turns := 0
			for _, e := range codexWire(t, x.dir) {
				var m map[string]any
				_ = json.Unmarshal(e.Data, &m)
				if e.Kind == "recv" && m["method"] == "turn/start" {
					turns++
				}
			}
			if turns != 1 {
				t.Fatalf("%s recovery sent user input: %d turns", mode, turns)
			}
			doc, err := store.ReadManaged("c")
			if err != nil || len(doc.State.Bindings) != 1 || doc.State.Bindings[0].NativeSessionID != before.State.Bindings[0].NativeSessionID || len(doc.State.Completed) != 1 {
				t.Fatalf("%s mutated the old binding: %+v %v", mode, doc.State, err)
			}
			if sendIngress(t, c, "must-not-replay").T != "err" {
				t.Fatal("unknown recovery auto replayed")
			}
		})
	}
}

func TestCodexOfficialSubprocessStartupAndTurnFailuresNeverFabricate(t *testing.T) {
	// This startup path only varies initialize/turn failure; the explicit
	// thread/start refusal is covered both for a first thread and for a cold
	// start after proven loss below.
	for _, mode := range []string{"startup-error", "init-error", "failed"} {
		t.Run(mode, func(t *testing.T) {
			x, store, _, c := codexIngress(t, mode)
			requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
			sent := sendIngress(t, c, "failed")
			phase := cr.PhaseUncertain
			if mode != "failed" {
				phase = cr.PhaseFailed
				if sent.T != "err" {
					t.Fatal("startup failure claimed submission")
				}
			} else {
				requireOK(t, sent)
			}
			awaitCodex(t, c, phase)
			doc, err := store.ReadManaged("c")
			if err != nil || len(doc.State.Completed) != 0 || len(doc.State.History) != 2 {
				t.Fatalf("fabricated completion: %+v %v", doc.State, err)
			}
			if x.dir == "" {
				t.Fatal("fixture dir")
			}
		})
	}
}

func TestCodexOfficialSubprocessApprovalsFailClosed(t *testing.T) {
	_, store, _, c := codexIngress(t, "approval")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","permissionMode":"deny","confirm":true}`))
	requireOK(t, sendIngress(t, c, "permission"))
	awaitCodex(t, c, cr.PhaseUncertain)
	if got := c.call("conversations.runtimeApprove", `{"id":"c","approvalId":"srv-approval","allow":true}`); got.T != "err" {
		t.Fatal("Codex deny-mode approval accepted instead of failing closed")
	}
	doc, err := store.ReadManaged("c")
	if err != nil || len(doc.State.Completed) != 0 || len(doc.State.Receipts) != 0 {
		t.Fatalf("approval fabricated delivery: %+v %v", doc.State, err)
	}
}

func TestCodexOfficialSubprocessApprovalExplicit(t *testing.T) {
	for _, allow := range []bool{false, true} {
		t.Run(fmt.Sprint(allow), func(t *testing.T) {
			x, store, _, c := codexIngress(t, "approval")
			requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
			requireOK(t, sendIngress(t, c, "permission"))
			st := waitClaudeState(t, c, func(st nativeView) bool { return len(st.Approvals) == 1 })
			if c.call("conversations.runtimeSelect", `{"id":"c","backend":"codex"}`).T != "err" {
				t.Fatal("switched with approval outstanding")
			}
			forged, _ := json.Marshal(map[string]any{"id": "c", "token": st.Token, "approvalId": "forged", "allow": true})
			if c.call("conversations.runtimeApprove", string(forged)).T != "err" {
				t.Fatal("forged approval accepted")
			}
			approvalID := st.Approvals[0]
			input, _ := json.Marshal(map[string]any{"id": "c", "token": st.Token, "approvalId": approvalID, "allow": allow})
			requireOK(t, c.call("conversations.runtimeApprove", string(input)))
			awaitCodex(t, c, cr.PhaseCompleted)
			messages, err := store.Messages("c", 0)
			if err != nil || len(messages) != 3 {
				t.Fatalf("permission completion %d %v", len(messages), err)
			}
			wantDec := "decline"
			if allow {
				wantDec = "accept"
			}
			answers := 0
			for _, e := range codexWire(t, x.dir) {
				var q map[string]any
				_ = json.Unmarshal(e.Data, &q)
				if e.Kind == "recv" && q["method"] == nil && q["id"] == "srv-approval" {
					if res, ok := q["result"].(map[string]any); ok {
						answers++
						if res["decision"] != wantDec {
							t.Fatalf("approval decision = %v, want %q", res["decision"], wantDec)
						}
					}
				}
			}
			if answers != 1 {
				t.Fatalf("expected exactly one explicit permission response, got %d", answers)
			}
		})
	}
}

func TestCodexOfficialSubprocessCancelWaitsProcessGroupAndDropsLateEvents(t *testing.T) {
	x, store, _, c := codexIngress(t, "hang")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
	requireOK(t, sendIngress(t, c, "cancel"))
	awaitCodex(t, c, cr.PhaseRunning)
	pid := 0
	for _, e := range codexWire(t, x.dir) {
		var d map[string]any
		_ = json.Unmarshal(e.Data, &d)
		if e.Kind == "launch" {
			pid = int(d["pid"].(float64))
		}
	}
	if pid == 0 {
		t.Fatal("fixture never launched")
	}
	requireOK(t, c.call("conversations.runtimeCancel", `{"id":"c"}`))
	awaitCodex(t, c, cr.PhaseCanceled)
	done := time.Now().Add(2 * time.Second)
	for processGroupAlive(t, pid, pid) && time.Now().Before(done) {
		time.Sleep(10 * time.Millisecond)
	}
	if processGroupAlive(t, pid, pid) {
		t.Fatal("cancel returned before the native process group exited")
	}
	time.Sleep(30 * time.Millisecond)
	doc, err := store.ReadManaged("c")
	if err != nil || len(doc.State.History) != 2 || len(doc.State.Completed) != 0 || len(doc.State.Receipts) != 0 {
		t.Fatalf("late native bytes mutated authority: %+v %v", doc.State, err)
	}
	if c.call("conversations.runtimeApprove", `{"id":"c","approvalId":"srv-approval","allow":true}`).T != "err" {
		t.Fatal("canceled generation could approve")
	}
}

func TestCodexOfficialSubprocessExplicitNewNativeAfterUnknownIsFullUnique(t *testing.T) {
	x, store, _, c := codexIngress(t, "success")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitCodex(t, c, cr.PhaseCompleted)
	first, err := store.ReadManaged("c")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	x.setMode(t, "other")
	if sendIngress(t, c, "cold").T != "err" {
		t.Fatal("unproven cold resumption accepted")
	}
	st := awaitCodex(t, c, cr.PhaseUncertain)
	if st.Recovery != cr.RecoveryUnknown {
		t.Fatal(st)
	}
	if got := c.call("conversations.runtimeResolve", `{"id":"c","decision":"new-native","confirm":true}`); got.T != "err" {
		t.Fatal("resolve without generation was accepted")
	}
	if got := c.call("conversations.runtimeSelect", `{"id":"c","backend":"codex"}`); got.T != "err" {
		t.Fatal("idle-only select allowed during unknown recovery")
	}
	if got := c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"new-native","confirm":false,"expectedGeneration":%d}`, st.Generation)); got.T != "err" {
		t.Fatal("unconfirmed resolve accepted")
	}
	turnsBefore := 0
	requireOK(t, c.call("conversations.runtimeResolve", fmt.Sprintf(`{"id":"c","decision":"new-native","confirm":true,"expectedGeneration":%d}`, st.Generation)))
	for _, e := range codexWire(t, x.dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind == "recv" && m["method"] == "turn/start" {
			turnsBefore++
		}
	}
	if turnsBefore != 1 {
		t.Fatalf("resolve itself sent user input: %d turns", turnsBefore)
	}
	requireOK(t, sendIngress(t, c, "after-new"))
	done := awaitCodex(t, c, cr.PhaseCompleted)
	if done.Recovery != cr.RecoveryNew {
		t.Fatalf("explicit decision must be RecoveryNew: %+v", done)
	}
	doc, err := store.ReadManaged("c")
	if err != nil || len(doc.State.Bindings) != 2 {
		t.Fatalf("old binding should be preserved beside the new native: %+v %v", doc.State.Bindings, err)
	}
	var oldKept, newSafe bool
	for _, b := range doc.State.Bindings {
		if b.NativeSessionID == first.State.Bindings[0].NativeSessionID && b.Status == cr.StatusStale {
			oldKept = true
		}
		if b.NativeSessionID != first.State.Bindings[0].NativeSessionID && b.NativeSessionID != "" && b.Status.Safe() {
			newSafe = true
		}
	}
	if !oldKept || !newSafe {
		t.Fatalf("native identity isolation failed: %+v", doc.State.Bindings)
	}
	turns := []string{}
	for _, e := range codexWire(t, x.dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind == "recv" && m["method"] == "turn/start" {
			turns = append(turns, fmt.Sprint(m["params"].(map[string]any)["input"]))
		}
	}
	if len(turns) != 2 {
		t.Fatalf("expected the original turn and exactly one post-resolve turn, got %q", turns)
	}
	if !strings.Contains(turns[1], "retained API history") || !strings.Contains(turns[1], "request one") || strings.Count(turns[1], "request after-new") != 1 || strings.Contains(turns[1], "request cold") {
		t.Fatalf("explicit new-native was not a full unique current request: %q", turns[1])
	}
}

func TestCodexOfficialSubprocessExplicitStartRejectionAfterLossIsFailed(t *testing.T) {
	x, store, r, c := codexIngress(t, "success")
	requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
	requireOK(t, sendIngress(t, c, "one"))
	awaitCodex(t, c, cr.PhaseCompleted)
	before, err := store.ReadManaged("c")
	if err != nil || len(before.State.Bindings) != 1 {
		t.Fatal("first binding", err)
	}
	// Reopen through the production registry path (an IPC State loads the
	// durable session); the durable old binding must be resumed cold before
	// thread/start can be exercised.
	requireOK(t, c.call("conversations.runtimeRelease", `{"id":"c"}`))
	requireOK(t, c.call("conversations.runtimeState", `{"id":"c"}`))
	_ = r
	// Only missing-start-error returns the exact "thread not found" for the old
	// thread and then rejects the explicit replacement thread/start; with plain
	// "start-error" thread/resume succeeds and no rejection is exercised.
	x.setMode(t, "missing-start-error")
	sent := sendIngress(t, c, "cold")
	if sent.T != "err" {
		b, _ := json.Marshal(sent)
		t.Fatalf("explicit thread/start rejection claimed submission: %s", b)
	}
	st := awaitCodex(t, c, cr.PhaseFailed)
	if st.Recovery != cr.RecoveryError {
		t.Fatalf("explicit stopped thread/start rejection is a safe pre-input failure: %+v", st)
	}
	turns, starts := 0, 0
	for _, e := range codexWire(t, x.dir) {
		var m map[string]any
		_ = json.Unmarshal(e.Data, &m)
		if e.Kind != "recv" {
			continue
		}
		switch m["method"] {
		case "turn/start":
			turns++
		case "thread/start":
			starts++
		}
	}
	if turns != 1 {
		t.Fatalf("start rejection sent user input: %d turns", turns)
	}
	// One start opened the first thread, one is the rejected cold start.
	if starts != 2 {
		t.Fatalf("fixture did not exercise an explicit thread/start rejection: %d starts", starts)
	}
	doc, err := store.ReadManaged("c")
	if err != nil || len(doc.State.Bindings) != 1 || doc.State.Bindings[0].NativeSessionID != before.State.Bindings[0].NativeSessionID ||
		doc.State.Bindings[0].Status != cr.StatusStale || len(doc.State.Bindings[0].Coverage.Delivered) != 3 || len(doc.State.Completed) != 1 {
		t.Fatalf("start rejection must keep the old native identity stale with history/coverage: %+v %v", doc.State, err)
	}
}

// TestCodexOfficialSubprocessExplicitThreadStartRefusalIsNotFabricated keeps
// the original first-thread coverage: with no binding the explicit
// thread/start rejection happens before any turn frame. A proven refusal after
// a CONFIRMED process-group stop is a safe pre-input failure (RecoveryError);
// anything unproven stays Unknown, forbids automatic sends and never records a
// native identity, completion or replay either way.
func TestCodexOfficialSubprocessExplicitThreadStartRefusalIsNotFabricated(t *testing.T) {
	// missing-start proves "thread not found" for the nonexistent previous
	// thread first; start-error is the plain first-thread refusal.
	for _, mode := range []string{"missing-start-error", "start-error"} {
		t.Run(mode, func(t *testing.T) {
			x, store, _, c := codexIngress(t, mode)
			requireOK(t, c.call("conversations.runtimeAdopt", `{"id":"c","backend":"codex","confirm":true}`))
			if got := sendIngress(t, c, "first"); got.T != "err" {
				b, _ := json.Marshal(got)
				t.Fatalf("explicit thread/start refusal claimed submission: %s", b)
			}
			// STRICT: a typed official thread/start refusal before any user
			// frame, with the process group confirmed stopped, is a safe
			// pre-input failure. Ambiguous/unproven cases are covered by the
			// Unknown tests, never by relaxing this one.
			st := awaitCodex(t, c, cr.PhaseFailed)
			if st.Recovery != cr.RecoveryError {
				t.Fatalf("proven refused start must be RecoveryError: %+v", st)
			}
			doc, err := store.ReadManaged("c")
			if err != nil {
				t.Fatal(err)
			}
			statuses := map[cr.Status]int{}
			for _, b := range doc.State.Bindings {
				statuses[b.Status]++
			}
			if !codexKind(t, x.dir, "launch") || codexTotalLaunches(t, x.dir) > 1 || codexCount(t, x.dir, "thread/start") != 1 {
				t.Fatalf("refused start used %d processes / %d thread/start frames", codexTotalLaunches(t, x.dir), codexCount(t, x.dir, "thread/start"))
			}
			pgid := 0
			for _, e := range codexWire(t, x.dir) {
				var d map[string]any
				_ = json.Unmarshal(e.Data, &d)
				if e.Kind == "launch" {
					pgid = int(d["pgid"].(float64))
				}
			}
			if pgid == 0 {
				t.Fatal("fixture never journaled its own process group")
			}
			deadline := time.Now().Add(2 * time.Second)
			for processGroupAlive(t, pgid, -1) && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if processGroupAlive(t, pgid, -1) {
				t.Fatal("refused start process group was not confirmed stopped")
			}
			users := 0
			for _, e := range doc.State.History {
				if e.Role == "user" && e.Text == "request first" {
					users++
				}
			}
			if len(doc.State.Completed) != 0 || len(doc.State.Receipts) != 0 || users != 1 {
				t.Fatalf("refused start fabricated delivery: %+v", doc.State)
			}
			for _, b := range doc.State.Bindings {
				if b.NativeSessionID == "" || b.Status.Safe() {
					t.Fatalf("refused start binding must stay unconfirmed: %+v", b)
				}
			}
			if len(doc.State.Bindings) > 1 {
				t.Fatalf("refused start created extra native identities: %+v", doc.State.Bindings)
			}
			if got := sendIngress(t, c, "after-refusal"); got.T != "err" {
				t.Fatal("refused start was replayed automatically")
			}
			if codexSentMethod(t, x.dir, "turn/start") {
				t.Fatal("post-refusal send reached native user input")
			}
		})
	}
}
