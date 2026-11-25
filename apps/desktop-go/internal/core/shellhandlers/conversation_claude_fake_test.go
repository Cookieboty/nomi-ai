package shellhandlers_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// The fake official Claude CLI is an ordinary executable: testdata/fakeclaude
// is built once per test binary with `go build` (standard library only, no
// network) and copied into each fixture directory, where the production
// driver starts it exactly as it would an installed CLI. It speaks the
// original test fixture's stream-json protocol over its own stdin/stdout/
// stderr and process lifetime/exit status; nothing is installed, logged in or
// paid, and there is no Python or shell involved. The stand-in reads "mode" and
// appends "wire.jsonl" in the working directory (the fixture) the driver gives
// it, so wire.jsonl is read from the same directory.
//
// Build once, copy per fixture: `go build` is too slow for every fixture and
// the copies must stand next to each fixture's own mode/wire files anyway.
var (
	fakeClaudeOnce sync.Once
	fakeClaudeSrc  string
	fakeClaudeErr  error
)

// fakeClaudeExeName is the name of the real executable on this OS (the driver
// runs it through nodeproc, which on Windows needs the executable extension).
func fakeClaudeExeName() string {
	if runtime.GOOS == "windows" {
		return "fake-claude.exe"
	}
	return "fake-claude"
}

func buildFakeClaude(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Fatalf("go toolchain not available to build the fake Claude CLI: %v", err)
	}
	fakeClaudeOnce.Do(func() {
		dir, err := os.MkdirTemp("", "fake-claude-bin-")
		if err != nil {
			fakeClaudeErr = err
			return
		}
		exe := filepath.Join(dir, fakeClaudeExeName())
		cmd := exec.Command("go", "build", "-o", exe, "./testdata/fakeclaude")
		cmd.Dir = "."
		if out, err := cmd.CombinedOutput(); err != nil {
			fakeClaudeErr = &buildError{err: err, out: string(out)}
			_ = os.RemoveAll(dir)
			return
		}
		fakeClaudeSrc = exe
	})
	if fakeClaudeErr != nil {
		t.Fatalf("build fake Claude CLI: %v", fakeClaudeErr)
	}
	return fakeClaudeSrc
}

type buildError struct {
	err error
	out string
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.out }

// installFakeClaude puts an executable copy of the stand-in into dir (the
// fixture the driver runs it in) and returns its path.
func installFakeClaude(t *testing.T, dir string) string {
	t.Helper()
	src := buildFakeClaude(t)
	exe := filepath.Join(dir, fakeClaudeExeName())
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, b, 0o755); err != nil {
		t.Fatal(err)
	}
	return exe
}

// replaceFakeClaudeWithBrokenImage rewrites the stand-in in place, keeping its
// exact path, as a file the OS refuses to start as a process. It must stay in
// place: claudert's Factory.Target (the production metadata check behind
// conversations.runtimeAdopt) EvalSymlinks and Stat's the executable before any
// spawn, so a fixture whose path is gone fails the adopt and never reaches the
// launch this test is about.
//
// The whole header is zeroed, including the Windows PE "MZ" magic (at offset 0
// of the .exe file too): Stat still sees a regular, non-empty file, while
//   - POSIX: the kernel cannot exec a zero-magic image (ENOEXEC);
//   - Windows: CreateProcess rejects the image (ERROR_BAD_EXE_FORMAT).
//
// Both are the OS refusing to start the process, not a permission-bit
// refusal (chmod is advisory to Windows) and not a missing path.
func replaceFakeClaudeWithBrokenImage(t *testing.T, exe string) {
	t.Helper()
	bad := make([]byte, 1024)
	if err := os.WriteFile(exe, bad, 0o755); err != nil {
		t.Fatal(err)
	}
}
