package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// #197：GitCommit 把 nil 与 util.Undefined 都当未传（TS paths != null），只提交已暂存的；空数组仍 invalid。
func TestGitCommitNullishPaths(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git missing")
	}
	dir := gitReal(t.TempDir())
	if err := os.WriteFile(filepath.Join(dir, "gitconfig"), []byte("[user]\n\tname = T\n\temail = t@x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(dir, "gitconfig"))
	A := filepath.Join(dir, "a")
	git := func(args ...string) string {
		t.Helper()
		c := exec.Command("git", args...)
		c.Dir = A
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	_ = os.MkdirAll(A, 0o755)
	git("init", "-q", "-b", "main")
	commit := func(paths any) *util.Obj {
		var r *util.Obj
		jsrt.Run(func() { r = GitCommit(A, "m", paths) })
		return r
	}
	for i, p := range []any{nil, util.Undefined} {
		f := filepath.Join(A, "f.txt")
		_ = os.WriteFile(f, []byte{byte('0' + i)}, 0o644)
		_ = os.WriteFile(filepath.Join(A, "u.txt"), []byte{byte('0' + i)}, 0o644)
		git("add", "f.txt")
		if r := commit(p); r.Get("ok") != true {
			t.Fatalf("paths %#v: %v", p, r)
		}
		if got := git("show", "--name-only", "--format=", "HEAD"); got != "f.txt" {
			t.Fatalf("paths %#v: committed %q", p, got)
		}
	}
	if r := commit([]any{}); r.Get("code") != "invalid" {
		t.Fatalf("empty paths: %v", r)
	}
}
