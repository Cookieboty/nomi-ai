package codexrt

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	cr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/conversationruntime"
)

// fakeServer is a local JSON-RPC app-server fixture. It NEVER reads credentials
// and never touches the network; resumeMode selects the official surface.
const fakeServer = `import json, sys, os
mode = os.environ.get("FAKE_CODEX_MODE", "ok")
counter = [0]
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    m = json.loads(line)
    method, mid = m.get("method"), m.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"userAgent": "fake-codex/0"}})
    elif method == "thread/resume":
        if mode == "ok":
            send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": m["params"]["threadId"]}}})
        elif mode == "missing":
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32600, "message": "thread not found"}})
        elif mode == "other":
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32600, "message": "thread not found: no rollout"}})
        elif mode == "empty":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif mode == "wrong":
            send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "different-thread"}}})
        elif mode == "hang":
            pass
    elif method in ("thread/start", "thread/resume"):
        counter[0] += 1
        send({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "new-thread-%d" % counter[0]}}})
    elif method == "thread/start":
        pass
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
`

func newFakeRuntime(t *testing.T, mode string) (*Runtime, func()) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX #!/bin/sh launcher for fake app-server")
	}
	py, err := findPython()
	if err != nil {
		t.Skip("python3 unavailable for fake app-server")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "fake_appserver.py")
	if err := os.WriteFile(script, []byte(fakeServer), 0700); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(dir, "codex")
	launcher := "#!/bin/sh\nexport FAKE_CODEX_MODE=" + mode + "\nexec " + py + " " + script + " \"$@\"\n"
	if err := os.WriteFile(exe, []byte(launcher), 0700); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(dir, "project")
	config := filepath.Join(dir, "codex-home")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config, 0700); err != nil {
		t.Fatal(err)
	}
	f := New(func(string) (Config, error) {
		return Config{Executable: exe, Cwd: project, ConfigDir: config}, nil
	})
	target, err := f.Target("conv")
	if err != nil {
		t.Fatal(err)
	}
	r := target.Runtime.(*Runtime)
	return r, func() { f.Release("conv") }
}

func findPython() (string, error) {
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", os.ErrNotExist
}

func TestRecoverClassification(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	token := cr.AttemptToken{ConversationID: "conv", AttemptID: "a", Generation: 1}
	cases := []struct {
		mode string
		want cr.RecoveryKind
		sid  string
	}{
		{"ok", cr.RecoveryResumed, "old-thread"},
		{"missing", cr.RecoveryFallback, "new-thread-1"},
		{"other", cr.RecoveryUnknown, ""},
		{"empty", cr.RecoveryUnknown, ""},
		{"wrong", cr.RecoveryUnknown, ""},
		{"hang", cr.RecoveryUnknown, ""},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			r, release := newFakeRuntime(t, c.mode)
			defer release()
			cctx := ctx
			if c.mode == "hang" {
				var cancel2 context.CancelFunc
				cctx, cancel2 = context.WithTimeout(ctx, 1500*time.Millisecond)
				defer cancel2()
			}
			got := r.Recover(cctx, cr.RecoveryRequest{Token: token, Previous: cr.Binding{ID: "b1", NativeSessionID: "old-thread"}})
			if got.Kind != c.want {
				t.Fatalf("%s: kind %s (%s), want %s", c.mode, got.Kind, got.Detail, c.want)
			}
			t.Logf("%s: %+v stderr=%q", c.mode, got, func() string {
				if r.worker == nil {
					return ""
				}
				return r.worker.stderr
			}())
			if c.sid != "" && got.NativeSessionID != c.sid {
				t.Fatalf("%s: sid %q, want %q", c.mode, got.NativeSessionID, c.sid)
			}
			if c.want == cr.RecoveryUnknown && got.NativeSessionID != "" {
				t.Fatalf("%s: unknown recovery produced a native id", c.mode)
			}
			// Recovery must never send the user turn itself.
			if r.worker != nil {
				if r.worker.active != nil {
					t.Fatalf("%s: recovery sent a turn", c.mode)
				}
			}
		})
	}
}

func TestRecoverNewWithoutPrevious(t *testing.T) {
	r, release := newFakeRuntime(t, "ok")
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	got := r.Recover(ctx, cr.RecoveryRequest{Token: cr.AttemptToken{ConversationID: "conv", AttemptID: "a"}})
	if got.Kind != cr.RecoveryNew || got.NativeSessionID != "new-thread-1" {
		t.Fatalf("new recovery = %+v", got)
	}
}

func FuzzMissingThread(f *testing.F) {
	f.Add("thread not found")
	f.Add("thread not foundx")
	f.Fuzz(func(t *testing.T, s string) {
		got := officialMissingThread(fmt.Errorf("%s", s))
		if got != (strings.TrimSpace(s) == OfficialMissingThread) {
			t.Fatalf("%q classified as %v", s, got)
		}
	})
}
