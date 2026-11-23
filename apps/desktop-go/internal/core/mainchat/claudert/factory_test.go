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
	exe := filepath.Join(dir, "fake")
	_ = os.WriteFile(exe, []byte("fake"), 0700)
	one, two := filepath.Join(dir, "one"), filepath.Join(dir, "two")
	_ = os.Mkdir(one, 0700)
	_ = os.Mkdir(two, 0700)
	link := filepath.Join(dir, "project")
	if err := os.Symlink(one, link); err != nil {
		t.Fatal(err)
	}
	f := New(func(string) (Config, error) { return Config{Executable: exe, Cwd: link, ConfigDir: dir}, nil })
	defer f.Release("c")
	a, err := f.Target("c")
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(link)
	_ = os.Symlink(two, link)
	b, err := f.Target("c")
	if err != nil || a.Identity.Cwd != one || b.Identity.Cwd != two || a.Identity.Key(a.Env) == b.Identity.Key(b.Env) {
		t.Fatal("retargeted cwd silently reused native identity")
	}
	_ = os.Remove(link)
	_ = os.Symlink(one, link)
	_ = os.Rename(one, one+"-old")
	_ = os.Mkdir(one, 0700)
	c, err := f.Target("c")
	if err != nil || a.Identity.Key(a.Env) == c.Identity.Key(c.Env) {
		t.Fatal("replaced project inode reused old native cwd")
	}
}
