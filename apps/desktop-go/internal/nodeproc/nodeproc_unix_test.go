//go:build !windows

package nodeproc

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type rec struct {
	out, errs []string
	close     chan [2]any
}

func run(t *testing.T, file string, args []string, o Options) (*Child, *rec) {
	r := &rec{close: make(chan [2]any, 1)}
	var c *Child
	jsrt.Run(func() {
		c = Spawn(file, args, o)
		c.OnStdout(func(s string) { r.out = append(r.out, s) })
		c.OnError(func(e error) { r.errs = append(r.errs, e.Error()) })
		c.OnClose(func(code *int, sig string) {
			var cv any
			if code != nil {
				cv = *code
			}
			r.close <- [2]any{cv, sig}
		})
	})
	return c, r
}

func wait(t *testing.T, r *rec) [2]any {
	select {
	case v := <-r.close:
		return v
	case <-time.After(10 * time.Second):
		t.Fatal("close timeout")
	}
	return [2]any{}
}

func TestSpawnENOENT(t *testing.T) {
	c, r := run(t, "definitely-not-a-cli-b7", nil, Options{})
	v := wait(t, r)
	if v[0] != -2 || v[1] != "" || len(r.errs) != 1 || r.errs[0] != "spawn definitely-not-a-cli-b7 ENOENT" || c.Pid != 0 {
		t.Fatalf("%v %v pid=%d", v, r.errs, c.Pid)
	}
	if *c.ExitCode() != -2 {
		t.Fatal(*c.ExitCode())
	}
}

func TestSpawnOutputAndExit(t *testing.T) {
	_, r := run(t, "sh", []string{"-c", "printf 'a\\nb'; exit 3"}, Options{})
	v := wait(t, r)
	if v[0] != 3 || v[1] != "" {
		t.Fatal(v)
	}
	all := ""
	for _, s := range r.out {
		all += s
	}
	if all != "a\nb" {
		t.Fatalf("%q", all)
	}
}

func TestKillSIGTERM(t *testing.T) {
	c, r := run(t, "sleep", []string{"30"}, Options{})
	time.Sleep(50 * time.Millisecond)
	var ok bool
	jsrt.Run(func() { ok = c.Kill("") })
	v := wait(t, r)
	if !ok || v[0] != nil || v[1] != "SIGTERM" || !c.Killed() {
		t.Fatal(ok, v)
	}
}

func TestDispatchThrowStopsListeners(t *testing.T) {
	var got []error
	old := jsrt.Uncaught
	jsrt.Uncaught = func(e error) { got = append(got, e) }
	defer func() { jsrt.Uncaught = old }()
	second := 0
	r := &rec{close: make(chan [2]any, 1)}
	jsrt.Run(func() {
		c := Spawn("sh", []string{"-c", "printf x"}, Options{})
		c.OnStdout(func(string) { panic(jsrt.JSThrow{Name: "TypeError", Message: "boom"}) })
		c.OnStdout(func(string) { second++ })
		c.OnClose(func(*int, string) { r.close <- [2]any{} })
	})
	wait(t, r)
	jsrt.Run(func() {
		if len(got) != 1 || got[0].Error() != "boom" || second != 0 {
			t.Fatal(got, second)
		}
	})
}
