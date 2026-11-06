//go:build !windows

package delegate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// #267：worktree 里已提交、但没有分支指着的成果，拆之前要留在分支上；留不住就保留目录

func commitIn(t *testing.T, wt, file, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(wt, file), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "cli: " + file}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = wt
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
}

func preserveRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not found")
	}
	dir := t.TempDir()
	gitRepo(t, dir, map[string]string{"README.md": "x"})
	otherBranch(t, dir)
	return dir
}

func prepareWT(t *testing.T, dir, key string) *IsolationHandle {
	t.Helper()
	h, err := PrepareIsolation(dir, key, "other")
	if err != nil || h.Kind != IsoWorktree {
		t.Fatalf("prepare %s: %v %+v", key, err, h)
	}
	return h
}

func TestLandKeepsCommittedDetachedHead(t *testing.T) {
	dir := preserveRepo(t)
	h := prepareWT(t, dir, "committed")
	commitIn(t, h.WorktreePath, "feature.txt", "done")
	// status 干净 → changed 为空
	r := LandWorktree(h, nil, "feature", func(string) bool { return true })
	if r.Kept || r.Branch == "" || r.Mode != "branch" {
		t.Fatalf("committed work must land on a branch: %+v", r)
	}
	if existsSync(h.WorktreePath) {
		t.Fatal("worktree should be removed once the commit is on a branch")
	}
	if !strings.Contains(filesOn(t, dir, r.Branch), "feature.txt") {
		t.Fatalf("branch %s misses the commit", r.Branch)
	}
}

func TestLandCleanWorktreeWithoutCommitsMakesNoBranch(t *testing.T) {
	dir := preserveRepo(t)
	h := prepareWT(t, dir, "clean")
	r := LandWorktree(h, nil, "nothing", nil)
	if r.Kept || r.Branch != "" || existsSync(h.WorktreePath) || len(branches(t, dir)) != 0 {
		t.Fatalf("clean worktree: %+v branches %v", r, branches(t, dir))
	}
}

func TestLandAppliesUncommittedAndKeepsCommitted(t *testing.T) {
	dir := preserveRepo(t)
	h := prepareWT(t, dir, "mixed")
	commitIn(t, h.WorktreePath, "committed.txt", "c")
	if err := os.WriteFile(filepath.Join(h.WorktreePath, "loose.txt"), []byte("l"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := LandWorktree(h, []string{"loose.txt"}, "mixed", func(string) bool { return true })
	if r.Kept || r.Branch == "" || len(r.Apply.Applied) != 1 {
		t.Fatalf("mixed: %+v", r)
	}
	if !strings.Contains(filesOn(t, dir, r.Branch), "committed.txt") {
		t.Fatal("committed change not kept")
	}
}

func TestLandKeepsWorktreeWhenBranchCannotBeCreated(t *testing.T) {
	dir := preserveRepo(t)
	h := prepareWT(t, dir, "blocked")
	commitIn(t, h.WorktreePath, "feature.txt", "done")
	// 已有 refs/heads/nomi：nomi/... 建不出来（引用命名冲突）
	if out, err := exec.Command("git", "-C", dir, "branch", "nomi").CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	r := LandWorktree(h, nil, "feature", nil)
	if !r.Kept || r.Err == "" || !existsSync(h.WorktreePath) {
		t.Fatalf("must keep the worktree when its commits can't be saved: %+v", r)
	}
	// 之后无人认领：启动清理同样留着
	if removed := SweepOrphanWorktrees([]string{dir}, nil, nil); len(removed) != 0 || !existsSync(h.WorktreePath) {
		t.Fatalf("sweep removed unsaved commits: %v", removed)
	}
	// 冲突解除后再清理：先留在分支上再拆，第二次清理不再建分支
	if out, err := exec.Command("git", "-C", dir, "branch", "-D", "nomi").CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	if removed := SweepOrphanWorktrees([]string{dir}, nil, nil); len(removed) != 1 || existsSync(h.WorktreePath) {
		t.Fatalf("sweep: %v", removed)
	}
	bs := branches(t, dir)
	if len(bs) != 1 || !strings.Contains(filesOn(t, dir, bs[0]), "feature.txt") {
		t.Fatalf("orphan commits not kept: %v", bs)
	}
}
