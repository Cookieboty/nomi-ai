package claudert

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestFactoryImmutableCompatibilityAndScopedRelease(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "fake")
	if err := os.WriteFile(exe, []byte("not executed"), 0700); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Executable: exe, Cwd: dir, ConfigDir: filepath.Join(dir, "config")}
	f := New(func(string) (Config, error) { return cfg, nil })
	a, err := f.Target("a")
	if err != nil {
		t.Fatal(err)
	}
	same, err := f.Target("a")
	if err != nil || same.Runtime != a.Runtime {
		t.Fatal("same binding lost warm runtime")
	}
	cfg.ConfigDir = filepath.Join(dir, "other-config")
	b, err := f.Target("a")
	if err != nil || a.Identity.Key(a.Env) == b.Identity.Key(b.Env) || a.Runtime == b.Runtime {
		t.Fatal("account source clobbered")
	}
	other, err := f.Target("b")
	if err != nil {
		t.Fatal(err)
	}
	f.Release("a")
	jsrt.Run(func() {
		if !a.Runtime.(*Runtime).closed || !b.Runtime.(*Runtime).closed || other.Runtime.(*Runtime).closed {
			t.Error("release did not isolate conversation/all old bindings")
		}
	})
	fresh, err := f.Target("a")
	if err != nil || fresh.Runtime == b.Runtime {
		t.Fatal("reacquired closed owner")
	}
	f.Release("a")
	f.Release("b")
}
func TestFactoryPhysicalCwdAndReplacementAreNewBindings(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX symlink replacement fixture")
	}
	dir := t.TempDir()
	// Build the fixture, then bind to its physical path exactly as the kernel
	// reports it. On macOS TMPDIR is /var/folders/..., while the OS reports and
	// launches processes in /private/var/folders/...; the alias is created
	// after the directories exist, so this holds on every host.
	exe := filepath.Join(dir, "fake")
	if err := os.WriteFile(exe, []byte("fake"), 0700); err != nil {
		t.Fatal(err)
	}
	one, two := filepath.Join(dir, "one"), filepath.Join(dir, "two")
	if err := os.Mkdir(one, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(two, 0700); err != nil {
		t.Fatal(err)
	}
	physical, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if physical != dir {
		// Keep the unresolved tree as a real alias of the physical one, so any
		// test path still resolves to exactly the directories bound below.
		alias := filepath.Join(dir, ".alias-of-physical")
		if err := os.Symlink(physical, alias); err != nil {
			t.Fatal(err)
		}
	}
	one, two = filepath.Join(physical, "one"), filepath.Join(physical, "two")
	exe = filepath.Join(physical, "fake")
	link := filepath.Join(physical, "project")
	if err := os.Symlink(one, link); err != nil {
		t.Fatal(err)
	}
	f := New(func(string) (Config, error) {
		return Config{Executable: exe, Cwd: link, ConfigDir: physical}, nil
	})
	defer f.Release("c")
	a, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	if a.Identity.Cwd != one {
		t.Fatalf("identity bound the link path, not the physical project: %q", a.Identity.Cwd)
	}
	// A retargeted link resolves to the NEW target and is a NEW binding.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(two, link); err != nil {
		t.Fatal(err)
	}
	b, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	if b.Identity.Cwd != two || a.Identity.Key(a.Env) == b.Identity.Key(b.Env) || a.Runtime == b.Runtime {
		t.Fatalf("retargeted cwd silently reused native identity: %q", b.Identity.Cwd)
	}
	// Relinking to the same, untouched directory is the same binding: the
	// directory never changed, only how it was named.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(one, link); err != nil {
		t.Fatal(err)
	}
	if again, err := f.Target("c"); err != nil || again.Identity.Key(again.Env) != a.Identity.Key(a.Env) {
		t.Fatalf("same directory through a new link became a new binding: %v", err)
	}
	// A directory replaced in place resolves to the new occupant. The old
	// directory is kept alive so the new one cannot inherit its inode, which
	// makes the identity difference come from the replacement alone.
	if err := os.Rename(one, one+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(one, 0700); err != nil {
		t.Fatal(err)
	}
	c, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	if c.Identity.Cwd != one || a.Identity.Key(a.Env) == c.Identity.Key(c.Env) {
		t.Fatalf("replaced project inode reused old native cwd: %q", c.Identity.Cwd)
	}
}
