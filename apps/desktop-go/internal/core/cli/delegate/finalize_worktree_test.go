//go:build !windows

package delegate

import (
	"fmt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
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
	ws, _ := filepath.Glob(filepath.Join(repo, hostports.DelegateWorktreeDir, "*"))
	return ws
}

// otherBranch：在仓库里建一个不在当前分支历史里的分支 other（多一个提交），回到原分支
func otherBranch(t *testing.T, dir string) {
	t.Helper()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	cur := run("rev-parse", "--abbrev-ref", "HEAD")
	run("checkout", "-q", "-b", "other")
	if err := os.WriteFile(filepath.Join(dir, "OTHER.md"), []byte("only on other"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "other")
	run("checkout", "-q", cur)
}

func branches(t *testing.T, dir string) []string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "branch", "--list", "nomi/*", "--format=%(refname:short)").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(out))
}

func filesOn(t *testing.T, dir, branch string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "show", "--name-only", "--format=", branch).Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// 没指定基线：git 仓库里直接在工作目录改，不开 worktree
func TestDelegateDefaultsToInPlace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("writeTab", util.NewObj("a.txt", "new"))}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x"})
	grantReal(t, e)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false), tools.ExecContext{})
	if b, _ := os.ReadFile(filepath.Join(e.dir, "a.txt")); string(b) != "new" {
		t.Fatalf("change should land in the working dir directly: %q (%s)", b, util.Stringify(r))
	}
	if _, err := os.Stat(filepath.Join(e.dir, hostports.DelegateWorktreeDir)); err == nil {
		t.Fatal("no worktree without a base branch")
	}
}

// 基线就是当前分支：照样直接改
func TestDelegateBaseOnCurrentBranchIsInPlace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("writeTab", util.NewObj("a.txt", "new"))}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x"})
	grantReal(t, e)
	cur, _ := exec.Command("git", "-C", e.dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	e.call(nil, "delegate_to_cli", delegateRaw("background", false, "base_branch", strings.TrimSpace(string(cur))), tools.ExecContext{})
	if b, _ := os.ReadFile(filepath.Join(e.dir, "a.txt")); string(b) != "new" {
		t.Fatalf("change should land in the working dir directly: %q", b)
	}
	if ws := worktrees(t, e.dir); len(ws) != 0 {
		t.Fatalf("no worktree for the current branch: %v", ws)
	}
}

// 基线是别的分支、改动少：在 worktree 里做，做完拷回当前工作区并拆掉 worktree
func TestDelegateOtherBaseSmallChangeIsApplied(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("writeTab", util.NewObj("fix.txt", "fixed"))}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x"})
	otherBranch(t, e.dir)
	grantReal(t, e)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false, "base_branch", "other"), tools.ExecContext{})
	if b, _ := os.ReadFile(filepath.Join(e.dir, "fix.txt")); string(b) != "fixed" {
		t.Fatalf("small change should be applied to the working dir: %q (%s)", b, util.Stringify(r))
	}
	if ws := worktrees(t, e.dir); len(ws) != 0 {
		t.Fatalf("worktree should be removed after landing: %v", ws)
	}
	if bs := branches(t, e.dir); len(bs) != 0 {
		t.Fatalf("small change needs no branch: %v", bs)
	}
}

// 基线是别的分支、改动多（51 个文件，失败收尾也一样）：不拷进当前分支，整体提交到新分支，拆掉 worktree（#255）
func TestDelegateOtherBaseLargeChangeGoesToBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	w := util.NewObj()
	for i := 1; i <= 51; i++ {
		w.Set(fmt.Sprintf("src/f%02d.txt", i), fmt.Sprintf("new %d", i))
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj("writeTab", w, "error", "CLI crashed")}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x"})
	otherBranch(t, e.dir)
	grantReal(t, e)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false, "base_branch", "other"), tools.ExecContext{})
	failed(t, r)
	if _, err := os.Stat(filepath.Join(e.dir, "src/f01.txt")); err == nil {
		t.Fatal("a large change must not be copied into the current branch")
	}
	bs := branches(t, e.dir)
	if len(bs) != 1 || !strings.HasPrefix(bs[0], "nomi/other-") {
		t.Fatalf("want one nomi/other-… branch: %v", bs)
	}
	if got := strings.Count(filesOn(t, e.dir, bs[0]), "src/f"); got != 51 {
		t.Fatalf("branch should hold all 51 files, has %d", got)
	}
	if ws := worktrees(t, e.dir); len(ws) != 0 {
		t.Fatalf("worktree should be removed once committed: %v", ws)
	}
	if note := util.Str(dataOf(r).Get("isolationNote")); !strings.Contains(note, bs[0]) {
		t.Fatalf("result should name the branch: %q", note)
	}
}

// 有文件拷不回当前工作区（复制失败）：拷得回去的照拷，拷不回去的提交到新分支，worktree 照样拆（改动不丢）
func TestDelegateLeftoverFilesGoToBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	e := newTaskEnv(t, util.NewObj("sends", []any{util.NewObj(
		"writeTab", util.NewObj("ok.txt", "applied", "ro/new.txt", "cannot copy"))}), nil)
	gitRepo(t, e.dir, map[string]string{"README.md": "x", "ro/keep.txt": "x"})
	otherBranch(t, e.dir)
	grantReal(t, e)
	ro := filepath.Join(e.dir, "ro")
	if err := os.Chmod(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(ro, 0o755)
	r := e.call(nil, "delegate_to_cli", delegateRaw("background", false, "base_branch", "other"), tools.ExecContext{})
	if b, _ := os.ReadFile(filepath.Join(e.dir, "ok.txt")); string(b) != "applied" {
		t.Fatalf("ok.txt not applied: %q", b)
	}
	bs := branches(t, e.dir)
	if len(bs) != 1 || !strings.Contains(filesOn(t, e.dir, bs[0]), "ro/new.txt") {
		t.Fatalf("uncopied file should be committed to a branch: %v", bs)
	}
	if ws := worktrees(t, e.dir); len(ws) != 0 {
		t.Fatalf("worktree should be removed once leftovers are committed: %v", ws)
	}
	if note := util.Str(dataOf(r).Get("isolationNote")); !strings.Contains(note, "ro/new.txt") || !strings.Contains(note, bs[0]) {
		t.Fatalf("result should say which file went to which branch: %q", note)
	}
}

// 启动清理：没人认领的委派 worktree，干净的直接拆，有改动的先提交到新分支；认领着的留着
func TestSweepOrphanWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	dir := t.TempDir()
	gitRepo(t, dir, map[string]string{"README.md": "x"})
	otherBranch(t, dir)
	mk := func(key string) *IsolationHandle {
		h, err := PrepareIsolation(dir, key, "other")
		if err != nil || h.Kind != IsoWorktree {
			t.Fatalf("prepare %s: %v %+v", key, err, h)
		}
		return h
	}
	clean, dirty, kept := mk("clean"), mk("dirty"), mk("kept")
	if err := os.WriteFile(filepath.Join(dirty.WorktreePath, "wip.txt"), []byte("wip"), 0o644); err != nil {
		t.Fatal(err)
	}
	removed := SweepOrphanWorktrees([]string{dir}, func(p string) bool { return strings.HasSuffix(p, "kept") }, nil)
	if len(removed) != 2 {
		t.Fatalf("want clean + dirty removed: %v", removed)
	}
	for _, h := range []*IsolationHandle{clean, dirty} {
		if existsSync(h.WorktreePath) {
			t.Fatalf("not removed: %s", h.WorktreePath)
		}
	}
	if !existsSync(kept.WorktreePath) {
		t.Fatal("claimed worktree was removed")
	}
	bs := branches(t, dir)
	if len(bs) != 1 || !strings.Contains(filesOn(t, dir, bs[0]), "wip.txt") {
		t.Fatalf("dirty orphan should be committed to a branch first: %v", bs)
	}
	ReleaseIsolation(kept, nil)
}

// 生产与开发共用项目仓库时，清理只能处理本构建创建的委派目录。
func TestSweepPreservesOtherProfileWorktrees(t *testing.T) {
	dir := t.TempDir()
	gitRepo(t, dir, map[string]string{"README.md": "x"})
	otherBranch(t, dir)
	own, err := PrepareIsolation(dir, "own", "other")
	if err != nil {
		t.Fatal(err)
	}
	foreignName := ".nomi-dev-delegate"
	if hostports.Development {
		foreignName = ".nomi-delegate"
	}
	foreign := filepath.Join(dir, foreignName, "active")
	if out, err := exec.Command("git", "-C", dir, "worktree", "add", "--detach", foreign, "other").CombinedOutput(); err != nil {
		t.Fatalf("foreign worktree: %s %v", out, err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "active.txt"), []byte("in-progress"), 0o644); err != nil {
		t.Fatal(err)
	}
	if IsDelegateWorktree(foreign) || !IsDelegateWorktree(own.WorktreePath) {
		t.Fatal("wrong profile ownership")
	}
	ownPath := realPath(own.WorktreePath)
	removed := SweepOrphanWorktrees([]string{dir}, nil, nil)
	if len(removed) != 1 || removed[0] != ownPath {
		t.Fatalf("removed = %v", removed)
	}
	if raw, err := os.ReadFile(filepath.Join(foreign, "active.txt")); err != nil || string(raw) != "in-progress" {
		t.Fatalf("foreign task changed: %s %v", raw, err)
	}
	if bs := branches(t, dir); len(bs) != 0 {
		t.Fatalf("foreign work was committed: %v", bs)
	}
}
