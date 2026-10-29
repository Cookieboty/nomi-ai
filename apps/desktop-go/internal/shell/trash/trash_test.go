//go:build linux

package trash

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTrashItem(t *testing.T) {
	var calls []string
	run = func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if name == "kioclient5" {
			return os.ErrNotExist
		}
		return nil
	}
	t.Cleanup(func() { run = runCmd })
	dir := t.TempDir()
	f := filepath.Join(dir, "s.jsonl")
	_ = os.WriteFile(f, []byte("x"), 0o600)
	t.Setenv("XDG_CURRENT_DESKTOP", "GNOME")
	if err := Item(f); err != nil || len(calls) != 1 || calls[0] != "gio trash "+f {
		t.Fatalf("gnome: %v %v", err, calls)
	}
	calls = nil
	t.Setenv("XDG_CURRENT_DESKTOP", "KDE")
	if err := Item(f); err != nil || strings.Join(calls, "|") != "kioclient5 move "+f+" trash:/|kioclient move "+f+" trash:/" {
		t.Fatalf("kde: %v %v", err, calls)
	}
	calls = nil
	if err := Item(filepath.Join(dir, "missing")); err == nil || len(calls) != 0 {
		t.Fatalf("missing: %v %v", err, calls)
	}
	if err := Item(""); err == nil {
		t.Fatal("empty path accepted")
	}
	run = func(name string, args ...string) error { return os.ErrPermission }
	t.Setenv("XDG_CURRENT_DESKTOP", "")
	if err := Item(f); err == nil {
		t.Fatal("failure swallowed")
	}
}
