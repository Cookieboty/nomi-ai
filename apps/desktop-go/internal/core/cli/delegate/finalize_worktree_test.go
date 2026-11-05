//go:build !windows

package delegate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// gitRepo：把 dir 变成有一个提交的 git 仓库（委派才会用 worktree 隔离）
func gitRepo(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for k, v := range files {
		p := filepath.Join(dir, k)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
}

// grantReal：git 给出的是解析过符号链接的路径（macOS 的 /var → /private/var），授权里也放上它
func grantReal(t *testing.T, e *taskEnv) {
	t.Helper()
	real, err := filepath.EvalSymlinks(e.dir)
	if err != nil {
		t.Fatal(err)
	}
	e.h.sc.Set("granted", []any{e.dir, real})
}

func failed(t *testing.T, r *util.Obj) {
	t.Helper()
	if st := util.Str(dataOf(r).Get("status")); st != "error" {
		t.Fatalf("want a failed delegation: %s", util.Stringify(r))
	}
}

func worktrees(t *testing.T, repo string) []string {
	t.Helper()
	ws, _ := filepath.Glob(filepath.Join(repo, ".nomi-delegate", "*"))
	return ws
}

// 同步委派失败：worktree 里改了 51 个文件，全部要拷回主工作树（不能只拷前 50 个再把 worktree 拆掉，#255）
func TestDelegateSyncErrorAppliesAllChangesBeforeCleanup(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	w := util.NewObj()
	for i := 1; i <= 51; i++ {
		w.Set(fmt.Sprintf("src/f%02d.txt", i), fmt.Sprintf("new %d", i))
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("writeTab", w, "error", "CLI crashed")}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x"})
	grantReal(t, e)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	failed(t, r)
	for i := 1; i <= 51; i++ {
		b, err := os.ReadFile(filepath.Join(e.dir, fmt.Sprintf("src/f%02d.txt", i)))
		if err != nil || string(b) != fmt.Sprintf("new %d", i) {
			t.Fatalf("file %d not applied to the main tree: %q %v", i, b, err)
		}
	}
	// 全部拷回了：失败的 worktree 可以拆
	if ws := worktrees(t, e.dir); len(ws) != 0 {
		t.Fatalf("worktree should be removed once everything is applied: %v", ws)
	}
}

// 有文件拷不回主工作树（复制失败）：失败收尾不能拆 worktree，结果里写明留在了哪里（#255）
func TestDelegateSyncErrorKeepsWorktreeWhenCopyFails(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj(
		"writeTab", util.NewObj("ok.txt", "applied", "ro/new.txt", "cannot copy"),
		"error", "CLI crashed")}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x", "ro/keep.txt": "x"})
	grantReal(t, e)
	ro := filepath.Join(e.dir, "ro")
	if err := os.Chmod(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(ro, 0o755)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	failed(t, r)
	if b, _ := os.ReadFile(filepath.Join(e.dir, "ok.txt")); string(b) != "applied" {
		t.Fatalf("ok.txt not applied: %q", b)
	}
	ws := worktrees(t, e.dir)
	if len(ws) != 1 {
		t.Fatalf("worktree with an uncopied file must be kept: %v (%s)", ws, util.Stringify(r))
	}
	if b, _ := os.ReadFile(filepath.Join(ws[0], "ro", "new.txt")); string(b) != "cannot copy" {
		t.Fatalf("uncopied file lost from the worktree: %q", b)
	}
	if note := util.Str(dataOf(r).Get("isolationNote")); !strings.Contains(note, "ro/new.txt") {
		t.Fatalf("result should say which file stayed in the worktree: %q", note)
	}
	os.Chmod(ro, 0o755)
	exec.Command("git", "-C", e.dir, "worktree", "remove", "--force", ws[0]).Run()
}
