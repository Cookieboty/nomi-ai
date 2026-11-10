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

// gitSummary 与 gitDiff 的规模一致（文件数按 status 行、增删按 numstat HEAD），但不带整份 diff
func TestGitSummaryMatchesDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatal(string(out))
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q")
	write("a.txt", "1\n2\n3\n")
	git("add", ".")
	git("commit", "-q", "-m", "init")
	write("a.txt", "1\nx\n3\n4\n") // +2 -1
	write("new.txt", "n\n")        // 未跟踪：只计数

	var s, d *util.Obj
	jsrt.Run(func() { s, d = GitSummary(repo), GitDiff(repo) })
	if s.Get("ok") != true {
		t.Fatalf("summary: %v", s.Get("error"))
	}
	if s.Get("status") != d.Get("status") {
		t.Fatalf("status %q vs %q", s.Get("status"), d.Get("status"))
	}
	if s.Get("added") != 2.0 || s.Get("removed") != 1.0 {
		t.Fatalf("added/removed = %v/%v", s.Get("added"), s.Get("removed"))
	}
	if s.Has("diff") {
		t.Fatal("summary must not carry the diff text")
	}
	// 并行跑的 diff 结果各就各位
	if d.Get("diff") == "" || d.Get("unstaged") == "" || d.Get("stat") == "" {
		t.Fatalf("diff fields missing: %v", d)
	}

	if r := func() (r *util.Obj) { jsrt.Run(func() { r = GitSummary(t.TempDir()) }); return }(); r.Get("ok") != false {
		t.Fatal("not a repo: ok=false")
	}
}
