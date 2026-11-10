package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMockCliBinWalksUpFromDesktopGo(t *testing.T) {
	root := t.TempDir()
	mock := filepath.Join(root, "scripts", "mock-cli")
	if err := os.MkdirAll(mock, 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(mock, "mock-claude.mjs")
	if err := os.WriteFile(bin, []byte("// mock\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "apps", "desktop-go")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(nested)
	t.Setenv("NOMI_USE_MOCK_CLI", "1")
	if got := MockCliBin("claude"); got != bin {
		t.Fatalf("got %q want %q", got, bin)
	}
	if MockCliBin("kimi") != "" {
		t.Fatal("missing mock should be empty")
	}
	t.Setenv("NOMI_USE_MOCK_CLI", "")
	if MockCliBin("claude") != "" {
		t.Fatal("flag off")
	}
}

func TestMockCliUpdate(t *testing.T) {
	if !MockCliUpdate("/repo/scripts/mock-cli/mock-claude.mjs", "2.0.0-mock") {
		t.Fatal("mock path")
	}
	if !MockCliUpdate("/usr/local/bin/claude", "2.0.0-mock") {
		t.Fatal("mock version")
	}
	if MockCliUpdate("/usr/local/bin/claude", "2.1.322") {
		t.Fatal("real cli")
	}
}
