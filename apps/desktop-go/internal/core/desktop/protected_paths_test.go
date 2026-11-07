package desktop

import (
	"os"
	"path/filepath"
	"testing"
)

func protectedBroker(t *testing.T, file, home string) *PermissionBroker {
	t.Helper()
	return NewPermissionBroker(file, GuardEnv{Home: home, Platform: Platform()}, BrokerOpts{})
}

func TestProtectedPathBlocksGrantedScopeAndPersists(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	proj := filepath.Join(home, "work", "proj")
	secret := filepath.Join(home, "work", "proj", "private")
	if err := os.MkdirAll(secret, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secret, "notes.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "settings.json")
	b := protectedBroker(t, file, home)
	b.Grant(proj, "read-write", "", false)
	if g := b.Guard(filepath.Join(secret, "notes.txt"), "read", false); !g.OK {
		t.Fatalf("before protecting, granted scope should allow: %+v", g)
	}

	saved, reason := b.AddProtectedPath(secret)
	if reason != "" || saved == "" {
		t.Fatalf("AddProtectedPath = %q, %q", saved, reason)
	}
	if g := b.Guard(filepath.Join(secret, "notes.txt"), "read", false); g.OK || g.Code != "denied" {
		t.Fatalf("protected folder must win over a granted scope: %+v", g)
	}
	if got := b.CheckCliWorkspace(secret); got == "" {
		t.Fatal("protected folder must not be usable as a coding-agent workspace")
	}
	if got := b.CheckCliWorkspace(proj); got != "" {
		t.Fatalf("parent project stays usable, got %q", got)
	}

	// 落盘：重新加载后仍然生效
	b2 := protectedBroker(t, file, home)
	if got := b2.ProtectedPaths(); len(got) != 1 || got[0] != saved {
		t.Fatalf("reloaded ProtectedPaths = %v", got)
	}
	if !b2.RemoveProtectedPath(saved) {
		t.Fatal("RemoveProtectedPath should report a change")
	}
	if g := b2.Guard(filepath.Join(secret, "notes.txt"), "read", false); !g.OK {
		t.Fatalf("after removing, granted scope allows again: %+v", g)
	}
}

func TestProtectedPathRejectsRootAndHome(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	b := protectedBroker(t, filepath.Join(root, "settings.json"), home)
	fsRoot := filepath.VolumeName(root) + string(filepath.Separator)
	for _, p := range []string{fsRoot, home, "relative/dir"} {
		if saved, reason := b.AddProtectedPath(p); reason == "" {
			t.Fatalf("AddProtectedPath(%q) should be refused, saved %q", p, saved)
		}
	}
	if got := b.ProtectedPaths(); len(got) != 0 {
		t.Fatalf("nothing should be saved, got %v", got)
	}
}

func TestCheckCliWorkspaceRejectsBroadAndBuiltinDenied(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home")
	ssh := filepath.Join(home, ".ssh")
	proj := filepath.Join(home, "code", "app")
	for _, d := range []string{ssh, proj} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	b := protectedBroker(t, filepath.Join(root, "settings.json"), home)
	if got := b.CheckCliWorkspace(home); got == "" {
		t.Fatal("home folder is too broad for a coding agent")
	}
	if got := b.CheckCliWorkspace(ssh); got == "" {
		t.Fatal(".ssh is a built-in protected folder")
	}
	if got := b.CheckCliWorkspace(filepath.Join(root, "missing")); got == "" {
		t.Fatal("missing folder must be refused")
	}
	if got := b.CheckCliWorkspace(proj); got != "" {
		t.Fatalf("a normal project folder is fine, got %q", got)
	}
}
