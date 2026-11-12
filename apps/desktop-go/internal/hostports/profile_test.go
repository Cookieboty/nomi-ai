package hostports

import (
	"path/filepath"
	"testing"
)

func TestProfileDataIsolation(t *testing.T) {
	prod, dev := t.TempDir(), t.TempDir()
	t.Setenv("NOMI_APP_DATA", prod)
	t.Setenv("NOMI_DEV_APP_DATA", dev)
	t.Setenv("NOMI_USER_DATA", "")
	t.Setenv("NOMI_DEV_USER_DATA", "")
	wantRoot, wantName, wantID := prod, "Nomi", "com.cookieboty.nomi"
	wantProgram, wantWorktree := "nomi", ".nomi-delegate"
	if Development {
		wantRoot, wantName, wantID = dev, "Nomi Dev", "com.cookieboty.nomi.dev"
		wantProgram, wantWorktree = "nomi-dev", ".nomi-dev-delegate"
	}
	if got := DefaultPaths().UserData(); got != filepath.Join(wantRoot, wantName) {
		t.Fatalf("user data = %q", got)
	}
	if AppID != wantID || GoProductName != wantName || ProgramName != wantProgram || DelegateWorktreeDir != wantWorktree {
		t.Fatalf("identity = %q / %q", AppID, GoProductName)
	}
	t.Setenv("NOMI_USER_DATA", filepath.Join(prod, "custom"))
	if Development {
		if got := DefaultPaths().UserData(); got != filepath.Join(dev, "Nomi Dev") {
			t.Fatalf("inherited production override: %q", got)
		}
		t.Setenv("NOMI_DEV_USER_DATA", filepath.Join(dev, "custom"))
		wantRoot = dev
	}
	if got := DefaultPaths().UserData(); got != filepath.Join(wantRoot, "custom") {
		t.Fatalf("profile override = %q", got)
	}
	if got := DefaultPaths().Logs(); got != filepath.Join(wantRoot, "custom", "logs") {
		t.Fatalf("logs = %q", got)
	}
	candidates := ElectronUserDataCandidates()
	if Development {
		if len(candidates) != 0 {
			t.Fatalf("dev must not discover production migration sources: %v", candidates)
		}
	} else if len(candidates) != 2 || candidates[0] != filepath.Join(prod, ElectronProductName) {
		t.Fatalf("production migration sources changed: %v", candidates)
	}
}
