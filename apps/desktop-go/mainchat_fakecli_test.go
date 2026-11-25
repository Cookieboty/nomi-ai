package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fakeCLIHelperEnv is the dispatch hook of a fake official CLI. installFakeCLI
// copies this test binary into an isolated directory as `claude` (claude.exe on
// Windows) and sets this variable in the test's environment, so a copy started
// with any arguments is a fake CLI; the copy the test runner started has it
// unset and never takes the dispatch path.
const fakeCLIHelperEnv = "NOMI_TEST_FAKE_CLI_HELPER"

// fakeCLIMarkerEnv carries the path of the marker the fake leaves when run.
const fakeCLIMarkerEnv = "NOMI_TEST_FAKE_CLI_MARKER"

// TestMain is the fake CLI entry point. A real probe (`claude --version`,
// `claude -p ...`, any arguments) starts the copied binary before any test or
// flag parsing happens: when fakeCLIHelperEnv is set, write the marker and exit
// non-zero instead of running the suite. A normal test run has no such
// environment, so it runs the suite unchanged.
func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv(fakeCLIHelperEnv); ok {
		runFakeCLI()
	}
	os.Exit(m.Run())
}

// runFakeCLI records that the fake official CLI was executed and never returns.
// It runs before flag.Parse, so testing flags in os.Args (someone running the
// copy directly as `claude -test.v=...`) are never rejected first.
func runFakeCLI() {
	failed := true
	if marker := os.Getenv(fakeCLIMarkerEnv); marker != "" {
		failed = os.WriteFile(marker, []byte("executed"), 0o600) != nil
	}
	if failed {
		os.Exit(91)
	}
	os.Exit(90)
}

// installFakeCLI writes a real executable named exactly like the official CLI
// (`name`, plus .exe on Windows: LookPath resolves that there) into dir, the
// directory made PATH, with this test binary as its body. Any execution of the
// fake writes marker and exits non-zero; the marker path is returned.
func installFakeCLI(t *testing.T, dir, name string) (exe, marker string) {
	t.Helper()
	dir, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	marker = filepath.Join(t.TempDir(), "MUST-NOT-EXECUTE")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe = filepath.Join(dir, name)
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	// Plain file copy: os.Executable may be a symlink to the real test binary.
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, data, 0o700); err != nil {
		t.Fatal(err)
	}
	// Only the fake directory: a real PATH would let the machine's installed
	// CLI be registered instead (or in addition), defeating the assertion.
	t.Setenv("PATH", dir)
	t.Setenv(fakeCLIHelperEnv, "1")
	t.Setenv(fakeCLIMarkerEnv, marker)
	return exe, marker
}

// assertFakeCLINotExecuted fails when anything ran the fake official CLI.
func assertFakeCLINotExecuted(t *testing.T, marker string) {
	t.Helper()
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("metadata registration/adoption executed CLI or probed login")
	}
}
