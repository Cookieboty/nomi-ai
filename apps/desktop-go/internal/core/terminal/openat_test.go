package terminal

import (
	"errors"
	"os/exec"
	"strings"
	"testing"
)

func TestOpenAtCommands(t *testing.T) {
	var got []*exec.Cmd
	run := func(c *exec.Cmd) error { got = append(got, c); return nil }
	has := func(names ...string) func(string) (string, error) {
		return func(n string) (string, error) {
			for _, x := range names {
				if x == n {
					return "/bin/" + n, nil
				}
			}
			return "", exec.ErrNotFound
		}
	}
	dir := "/w/my app"
	_ = openAt("darwin", dir, has(), run)
	if a := strings.Join(got[0].Args, " "); a != "open -a Terminal /w/my app" {
		t.Fatalf("mac: %q", a)
	}
	_ = openAt("windows", dir, has("wt.exe"), run)
	if a := got[1].Args; a[len(a)-2] != "-d" || a[len(a)-1] != dir {
		t.Fatalf("windows terminal: %q", a)
	}
	_ = openAt("windows", dir, has(), run)
	if a := strings.Join(got[2].Args, " "); !strings.Contains(a, "start  /D /w/my app powershell.exe") {
		t.Fatalf("windows fallback: %q", a)
	}
	_ = openAt("linux", dir, has("gnome-terminal"), run)
	if a := got[3].Args; a[len(a)-1] != "--working-directory="+dir {
		t.Fatalf("linux: %q", a)
	}
	_ = openAt("linux", dir, has("xterm"), run)
	if got[4].Dir != dir {
		t.Fatalf("xterm runs in dir: %q", got[4].Dir)
	}
	if err := openAt("linux", dir, has(), run); !errors.Is(err, ErrNoTerminal) {
		t.Fatalf("no terminal: %v", err)
	}
}
