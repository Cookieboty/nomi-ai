package harness

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveHarnessBinMockMissingIsNotInstalled(t *testing.T) {
	root := t.TempDir()
	mock := filepath.Join(root, "scripts", "mock-cli")
	if err := os.MkdirAll(mock, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mock, "mock-claude.mjs"), []byte("// mock\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "apps", "desktop-go")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	if got := ResolveHarnessBin("claude"); got != filepath.Join(mock, "mock-claude.mjs") {
		t.Fatalf("claude: %q", got)
	}
	if got := ResolveHarnessBin("kimi"); got != "" {
		t.Fatalf("missing mock should be empty, got %q", got)
	}
}
