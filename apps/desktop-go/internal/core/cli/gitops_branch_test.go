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

// 分支切换：列出本地分支、切换、新建并切换；名字不合法 / 已存在 / 有会被覆盖的改动时给出 code，不丢改动。
func TestGitBranchesAndCheckout(t *testing.T) {
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
	_ = os.MkdirAll(A, 0o755)
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
	run := func(fn func() *util.Obj) *util.Obj {
		var r *util.Obj
		jsrt.Run(func() { r = fn() })
		return r
	}

	// 不是仓库：nil
	if r := run(func() *util.Obj { return GitBranches(A) }); r != nil {
		t.Fatalf("not a repo: %v", r)
	}
	git("init", "-q", "-b", "main")
	f := filepath.Join(A, "f.txt")
	_ = os.WriteFile(f, []byte("1"), 0o644)
	git("add", "f.txt")
	git("commit", "-q", "-m", "one")
	git("branch", "feat/x")

	r := run(func() *util.Obj { return GitBranches(A) })
	if r.Get("current") != "main" {
		t.Fatalf("current: %v", r)
	}
	names := r.Get("branches").([]any)
	if len(names) != 2 {
		t.Fatalf("branches: %v", names)
	}

	if r := run(func() *util.Obj { return GitCheckout(A, "feat/x", nil) }); r.Get("ok") != true {
		t.Fatalf("switch: %v", r)
	}
	if got := git("symbolic-ref", "--short", "HEAD"); got != "feat/x" {
		t.Fatalf("HEAD = %q", got)
	}
	if r := run(func() *util.Obj { return GitCheckout(A, "feat/new", true) }); r.Get("ok") != true {
		t.Fatalf("create: %v", r)
	}
	if got := git("symbolic-ref", "--short", "HEAD"); got != "feat/new" {
		t.Fatalf("HEAD after create = %q", got)
	}
	if r := run(func() *util.Obj { return GitCheckout(A, "main", true) }); r.Get("code") != "exists" {
		t.Fatalf("create existing: %v", r)
	}
	for _, bad := range []any{"", "-f", "a..b", "bad name", 3} {
		if r := run(func() *util.Obj { return GitCheckout(A, bad, nil) }); r.Get("code") != "invalid" {
			t.Fatalf("name %#v: %v", bad, r)
		}
	}

	// 两个分支上同一文件内容不同，工作区里有未提交改动：git 拒绝切换，改动还在
	_ = os.WriteFile(f, []byte("2"), 0o644)
	git("commit", "-q", "-am", "two")
	_ = os.WriteFile(f, []byte("dirty"), 0o644)
	if r := run(func() *util.Obj { return GitCheckout(A, "main", nil) }); r.Get("code") != "dirty" {
		t.Fatalf("dirty switch: %v", r)
	}
	if b, _ := os.ReadFile(f); string(b) != "dirty" {
		t.Fatalf("lost changes: %q", b)
	}
}
