package delegate

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestEditLogSince(t *testing.T) {
	l := NewEditLog()
	cwd := filepath.Join(t.TempDir(), "repo")
	l.Note("a", []string{filepath.Join(cwd, "x.go"), "rel/y.go"}, 100)
	l.Note("a", []string{filepath.Join(cwd, "x.go")}, 150) // 同一个文件改两次只列一次
	l.Note("a", []string{"/elsewhere/z.go"}, 200)
	l.Note("b", []string{"other.go"}, 150)
	if got := fmt.Sprint(l.Since("a", cwd, 0, 0)); got != "[x.go rel/y.go /elsewhere/z.go]" {
		t.Fatal(got)
	}
	if got := fmt.Sprint(l.Since("a", cwd, 120, 180)); got != "[x.go]" {
		t.Fatal(got)
	}
	if got := l.Since("missing", cwd, 0, 0); len(got) != 0 {
		t.Fatal(got)
	}
	l.Forget("a")
	if got := l.Since("a", cwd, 0, 0); len(got) != 0 {
		t.Fatal(got)
	}
	l.Note("c", []string{"keep.go"}, 100)
	l.Retain([]string{"c"})
	if len(l.Since("b", cwd, 0, 0)) != 0 || len(l.Since("c", cwd, 0, 0)) != 1 {
		t.Fatal("retain failed")
	}
	var nilLog *EditLog
	nilLog.Note("a", []string{"x"}, 1)
	nilLog.Retain([]string{"a"})
	if nilLog.Since("a", "", 0, 0) != nil {
		t.Fatal("nil log")
	}
}

func TestEditLogKeepsRecent(t *testing.T) {
	l := NewEditLog()
	for i := 0; i < maxEditsPerTab+10; i++ {
		l.Note("a", []string{fmt.Sprintf("f%d", i)}, float64(i))
	}
	got := l.Since("a", "", 0, 0)
	if len(got) != maxEditsPerTab || got[0] != "f10" {
		t.Fatal(len(got), got[0])
	}
}
