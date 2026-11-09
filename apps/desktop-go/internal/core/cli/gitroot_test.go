package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// gitDiff 带上仓库根：项目里同一个仓库的两个文件夹在右栏合成一段
func TestGitDiffReportsGitRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	sub := filepath.Join(repo, "api")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", repo, "init", "-q").CombinedOutput(); err != nil {
		t.Fatal(string(out))
	}
	real, _ := filepath.EvalSymlinks(repo)
	diff := func(dir string) (r *util.Obj) {
		jsrt.Run(func() { r = GitDiff(dir) })
		return r
	}
	for _, dir := range []string{repo, sub} {
		r := diff(dir)
		if r.Get("ok") != true {
			t.Fatalf("%s: %v", dir, r.Get("error"))
		}
		got, _ := r.Get("gitRoot").(string)
		if g, _ := filepath.EvalSymlinks(got); g != real {
			t.Fatalf("%s: gitRoot = %q, want %q", dir, got, real)
		}
	}
	if r := diff(t.TempDir()); r.Get("gitRoot") != nil {
		t.Fatal("not a repo: no gitRoot")
	}
}
