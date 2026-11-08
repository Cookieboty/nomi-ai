package delegate

// worktree.go：委派的工作目录。默认直接在源目录里改（同一仓库里的并发写由 claims.go 按文件、按优先级裁决）；
// 只有明确指定了别的分支做基线、且那个分支不在当前分支的历史里时，才从它开一个 git worktree。
// worktree 做完「落地」：改动少拷回当前工作区，改动多（或拷不回去的）提交到新分支 nomi/…，然后拆掉。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
)

// MaxParallelDelegates：同时处于 running 的委派上限的默认值（含 worktree / shared-cwd）
const MaxParallelDelegates = 3

// parallelLimit：调度策略改过的上限（SetMaxParallel，Agent 看板）；0 = 默认
var parallelLimit atomic.Int32

// SetMaxParallel：改同时运行的委派上限（<= 0 = 默认）；调大后由调用方 WakeSlots 放行排队的
func SetMaxParallel(n int) { parallelLimit.Store(int32(max(0, n))) }

func maxParallel() int {
	if n := parallelLimit.Load(); n > 0 {
		return int(n)
	}
	return MaxParallelDelegates
}

var pth = nodepath.Lib(nodepath.Platform())

// 隔离方式：worktree = 从别的分支开的 worktree；in-place = git 仓库里直接改；shared-cwd = 不是 git 仓库
const (
	IsoWorktree = "worktree"
	IsoInPlace  = "in-place"
	IsoShared   = "shared-cwd"
)

// IsolationHandle：{ kind, cwd, sourceCwd, gitRoot?, worktreePath?, baseBranch?, baseCommit?, note }（JSON 键序固定）
type IsolationHandle struct {
	Kind         string `json:"kind"`
	Cwd          string `json:"cwd"`
	SourceCwd    string `json:"sourceCwd"`
	GitRoot      string `json:"gitRoot,omitempty"`
	WorktreePath string `json:"worktreePath,omitempty"`
	BaseBranch   string `json:"baseBranch,omitempty"`
	BaseCommit   string `json:"baseCommit,omitempty"`
	Note         string `json:"note"`
}

// Obj：序列化用的有序对象
func (h *IsolationHandle) Obj() *util.Obj {
	o := util.NewObj("kind", h.Kind, "cwd", h.Cwd, "sourceCwd", h.SourceCwd)
	if h.GitRoot != "" {
		o.Set("gitRoot", h.GitRoot)
	}
	if h.WorktreePath != "" {
		o.Set("worktreePath", h.WorktreePath)
	}
	if h.BaseBranch != "" {
		o.Set("baseBranch", h.BaseBranch)
	}
	if h.BaseCommit != "" {
		o.Set("baseCommit", h.BaseCommit)
	}
	o.Set("note", h.Note)
	return o
}

// 持久化的 isolation 原样读回（只读这几个字段）
func isolationFromObj(o *util.Obj) *IsolationHandle {
	return &IsolationHandle{
		Kind: util.Str(o.Get("kind")), Cwd: util.Str(o.Get("cwd")), SourceCwd: util.Str(o.Get("sourceCwd")),
		GitRoot: util.Str(o.Get("gitRoot")), WorktreePath: util.Str(o.Get("worktreePath")),
		BaseBranch: util.Str(o.Get("baseBranch")), BaseCommit: util.Str(o.Get("baseCommit")), Note: util.Str(o.Get("note")),
	}
}

func stripGitEnv(extra ...string) []string {
	drop := map[string]bool{"GIT_DIR": true, "GIT_WORK_TREE": true, "GIT_COMMON_DIR": true, "GIT_INDEX_FILE": true,
		"GIT_OBJECT_DIRECTORY": true, "GIT_ALTERNATE_OBJECT_DIRECTORIES": true}
	for _, k := range extra {
		drop[k] = true
	}
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if !drop[k] {
			env = append(env, kv)
		}
	}
	return env
}

// execFileError：child_process.execFile 失败时的 Error.message（"Command failed: cmd args\nstderr"）
func execFileError(args []string, err error, stderr string) error {
	var ee *exec.ExitError
	if errors.As(err, &ee) || stderr != "" {
		return errors.New("Command failed: git " + strings.Join(args, " ") + "\n" + stderr)
	}
	return err
}

func runGit(cwd string, args []string, timeout time.Duration, env []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	hideWindow(cmd)
	cmd.Dir = cwd
	cmd.Env = env
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), execFileError(args, err, errb.String())
	}
	return out.String(), nil
}

func git(cwd string, args ...string) (string, error) {
	return runGit(cwd, args, 30*time.Second, stripGitEnv())
}

func realPath(p string) string {
	r, err := desktop.RealpathNative(p)
	if err != nil {
		return p
	}
	return r
}

// insideRel：path.relative 结果不以 .. 开头且非绝对
func insideRel(rel string) bool { return !strings.HasPrefix(rel, "..") && !pth.IsAbsolute(rel) }

// ResolveGitRoot：cwd 是否落在某个 git 仓库内；返回 toplevel，否则 ""
func ResolveGitRoot(cwd string) string {
	out, err := git(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	root := trim(out)
	if root == "" {
		return ""
	}
	if !insideRel(pth.Relative(realPath(root), realPath(pth.Resolve(cwd)))) {
		return ""
	}
	return root
}

var unsafeIDRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func safeID(raw string) string {
	s := slice(unsafeIDRe.ReplaceAllString(raw, "-"), 48)
	if s == "" {
		return "task"
	}
	return s
}

// EnsureDelegateExclude：info/exclude 加上 .nomi-delegate/（非致命）
func EnsureDelegateExclude(gitRoot string) {
	out, err := git(gitRoot, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return
	}
	o := trim(out)
	if o == "" {
		return
	}
	exclude := pth.Resolve(gitRoot, o)
	if os.MkdirAll(pth.Dirname(exclude), 0o777) != nil {
		return
	}
	const marker = ".nomi-delegate/"
	cur := ""
	if b, err := os.ReadFile(exclude); err == nil {
		cur = string(b)
	}
	for _, l := range crlfRe.Split(cur, -1) {
		if trim(l) == marker {
			return
		}
	}
	sep := "\n"
	if strings.HasSuffix(cur, "\n") || cur == "" {
		sep = ""
	}
	f, err := os.OpenFile(exclude, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return
	}
	_, _ = f.WriteString(sep + "# Nomi delegate worktrees\n" + marker + "\n")
	_ = f.Close()
}

func sharedCwd(sourceCwd string) *IsolationHandle {
	return &IsolationHandle{Kind: IsoShared, Cwd: sourceCwd, SourceCwd: sourceCwd,
		Note: tr.T("electron.common.the-working-directory-is-not-a-git-repository") + tr.T("electron.common.hand-off-tasks-one-at-a-time-or")}
}

func inPlace(sourceCwd, root, base string) *IsolationHandle {
	note := "直接在工作目录里改（同一仓库里并行的任务改到同一个文件时，按优先级让路）"
	if base != "" {
		note = "基线 " + base + " 就在当前分支的历史里，直接在工作目录里改"
	}
	return &IsolationHandle{Kind: IsoInPlace, Cwd: sourceCwd, SourceCwd: sourceCwd, GitRoot: root, BaseBranch: base, Note: note}
}

func existsSync(p string) bool { _, err := os.Stat(p); return err == nil }

// resolveBase：基线分支 → 提交；own = 基线就是当前分支，或者它的提交已经在当前分支的历史里（不用另开 worktree）
func resolveBase(root, base string) (commit string, own bool, err error) {
	if base == "HEAD" {
		return "", true, nil
	}
	if cur, e := git(root, "symbolic-ref", "--short", "-q", "HEAD"); e == nil && trim(cur) == base {
		return "", true, nil
	}
	for _, ref := range []string{base, "origin/" + base} {
		if out, e := git(root, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); e == nil && trim(out) != "" {
			commit = trim(out)
			break
		}
	}
	if commit == "" {
		return "", false, fmt.Errorf("找不到基线分支 %s", base)
	}
	if _, e := git(root, "merge-base", "--is-ancestor", commit, "HEAD"); e == nil {
		return commit, true, nil
	}
	return commit, false, nil
}

// PrepareIsolation：不是 git 仓库 → shared-cwd；没指定基线、或基线属于当前分支 → in-place（直接在源目录里改）；
// 基线是别的分支 → 从它开 worktree（detached，`<sourceCwd>/.nomi-delegate/<id>`）
func PrepareIsolation(sourceCwd, taskKey, baseBranch string) (*IsolationHandle, error) {
	root := ResolveGitRoot(sourceCwd)
	if root == "" {
		return sharedCwd(sourceCwd), nil
	}
	base := trim(baseBranch)
	if base == "" {
		return inPlace(sourceCwd, root, ""), nil
	}
	commit, own, err := resolveBase(root, base)
	if err != nil {
		return nil, err
	}
	if own {
		return inPlace(sourceCwd, root, base), nil
	}
	id := safeID(taskKey)
	wt := pth.Join(pth.Resolve(sourceCwd), ".nomi-delegate", id)
	EnsureDelegateExclude(root)
	if err := os.MkdirAll(pth.Dirname(wt), 0o777); err != nil {
		return nil, err
	}
	if existsSync(wt) {
		if _, err := git(root, "worktree", "remove", "--force", wt); err != nil {
			_ = os.RemoveAll(wt)
			_, _ = git(root, "worktree", "prune")
		}
	}
	if _, err := git(root, "worktree", "add", "--detach", wt, commit); err != nil {
		return nil, fmt.Errorf("无法创建委派 worktree：%s", err.Error())
	}
	return &IsolationHandle{Kind: IsoWorktree, Cwd: wt, SourceCwd: sourceCwd, GitRoot: root, WorktreePath: wt,
		BaseBranch: base, BaseCommit: commit, Note: "基于分支 " + base + " 在独立的 git worktree 里改：" + wt}, nil
}

// ReleaseIsolation：拆除 worktree；shared-cwd 无操作。失败只记日志。
func ReleaseIsolation(h *IsolationHandle, log func(string)) {
	if h == nil || h.Kind != "worktree" || h.WorktreePath == "" || h.GitRoot == "" {
		return
	}
	if _, err := git(h.GitRoot, "worktree", "remove", "--force", h.WorktreePath); err != nil {
		if log != nil {
			log("worktree remove failed: " + err.Error() + "; falling back to rm")
		}
		if e2 := os.RemoveAll(h.WorktreePath); e2 != nil {
			if log != nil {
				log("worktree cleanup failed: " + e2.Error())
			}
			return
		}
		if _, e2 := git(h.GitRoot, "worktree", "prune"); e2 != nil && log != nil {
			log("worktree cleanup failed: " + e2.Error())
		}
	}
}

// ApplyResult：applyWorktreeToMain 的结果
type ApplyResult struct{ Applied, Skipped, Conflicted, Denied []string }

// ApplyWorktreeToMain：把 worktree 内改动拷回主工作树；主工作树有改动的 → conflicted，mayWrite 不过 → denied
func ApplyWorktreeToMain(h *IsolationHandle, changed []string, mayWrite func(dest string) bool) ApplyResult {
	r := ApplyResult{Applied: []string{}, Skipped: []string{}, Conflicted: []string{}, Denied: []string{}}
	if h.Kind != "worktree" || h.WorktreePath == "" || h.GitRoot == "" {
		return r
	}
	for _, rel := range changed {
		if rel == "" || strings.Contains(rel, "..") || pth.IsAbsolute(rel) {
			r.Skipped = append(r.Skipped, rel)
			continue
		}
		if !safeMayWrite(mayWrite, pth.Join(h.GitRoot, rel)) {
			r.Denied = append(r.Denied, rel)
			continue
		}
		if !isMainPathClean(h.GitRoot, rel) {
			r.Conflicted = append(r.Conflicted, rel)
			continue
		}
		src, dest := pth.Join(h.WorktreePath, rel), pth.Join(h.GitRoot, rel)
		switch {
		case existsSync(src):
			if os.MkdirAll(pth.Dirname(dest), 0o777) != nil || copyFile(src, dest) != nil {
				r.Skipped = append(r.Skipped, rel)
			} else {
				r.Applied = append(r.Applied, rel)
			}
		case existsSync(dest):
			if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
				r.Skipped = append(r.Skipped, rel)
			} else {
				r.Applied = append(r.Applied, rel)
			}
		default:
			r.Skipped = append(r.Skipped, rel)
		}
	}
	return r
}

func safeMayWrite(f func(string) bool, dest string) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return f(dest)
}

func copyFile(src, dest string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dest, b, st.Mode().Perm())
}

func isMainPathClean(gitRoot, rel string) bool {
	out, err := git(gitRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", rel)
	if err != nil {
		return false
	}
	return trim(out) == ""
}

// 落地的规模线：超过任一条就不往当前分支拷，整体提交到新分支
const (
	LandMaxFiles = 10
	LandMaxLines = 400
)

// LandResult：worktree 落地的结果。Mode：applied = 拷回了当前工作区（拷不回去的另提交到 Branch）；
// branch = 改动多，整体提交到了 Branch；none = 没有改动。Kept = worktree 留着（提交失败，改动还在里面）
type LandResult struct {
	Mode   string
	Branch string
	Apply  ApplyResult
	Kept   bool
	Err    string
}

func safeRel(rel string) bool {
	return rel != "" && !strings.Contains(rel, "..") && !pth.IsAbsolute(rel)
}

// diffLines：暂存这些文件后的增删行数（二进制文件不计行）
func diffLines(wt string, files []string) (int, error) {
	if _, err := git(wt, append([]string{"add", "-A", "--"}, files...)...); err != nil {
		return 0, err
	}
	out, err := git(wt, "diff", "--cached", "--numstat")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, l := range crlfRe.Split(out, -1) {
		f := strings.Fields(l)
		if len(f) < 2 {
			continue
		}
		var a, d int
		_, _ = fmt.Sscanf(f[0], "%d", &a)
		_, _ = fmt.Sscanf(f[1], "%d", &d)
		n += a + d
	}
	return n, nil
}

var branchUnsafeRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func branchPart(s string) string {
	p := strings.Trim(branchUnsafeRe.ReplaceAllString(s, "-"), "-.")
	if len(p) > 40 {
		p = strings.Trim(p[:40], "-.")
	}
	return p
}

// CommitToBranch：把 worktree 里这些文件的改动提交成一个新分支 nomi/<基线>-<id>（不跑钩子、不签名；
// 没配身份时用 Nomi 的）。返回分支名
func CommitToBranch(h *IsolationHandle, files []string, title string) (string, error) {
	wt := h.WorktreePath
	_, _ = git(wt, "reset", "-q")
	if _, err := git(wt, append([]string{"add", "-A", "--"}, files...)...); err != nil {
		return "", err
	}
	msg := "nomi: " + slice(trim(strings.SplitN(title, "\n", 2)[0]), 90)
	if trim(title) == "" {
		msg = "nomi: delegated changes"
	}
	args := []string{"-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", msg}
	if _, err := git(wt, args...); err != nil {
		id := []string{"-c", "user.name=Nomi", "-c", "user.email=nomi@localhost"}
		if _, err2 := git(wt, append(id, args...)...); err2 != nil {
			return "", err2
		}
	}
	return branchAtHead(h)
}

// branchAtHead：在 worktree 的 HEAD 上建一个没被占用的新分支 nomi/<基线>-<id>[-n]，返回分支名
func branchAtHead(h *IsolationHandle) (string, error) {
	wt := h.WorktreePath
	base := branchPart(h.BaseBranch)
	if base == "" {
		base = "worktree"
	}
	name := "nomi/" + base + "-" + safeID(pth.Basename(wt))
	for i := 2; ; i++ {
		if _, err := git(h.GitRoot, "rev-parse", "--verify", "--quiet", "refs/heads/"+name); err != nil {
			break
		}
		name = fmt.Sprintf("nomi/%s-%s-%d", base, safeID(pth.Basename(wt)), i)
	}
	if _, err := git(wt, "branch", name, "HEAD"); err != nil {
		return "", err
	}
	return name, nil
}

// headUnreachable：worktree 的 HEAD 上有任何分支 / 标签 / 远程分支都够不着的提交（编程助手在 detached HEAD
// 上提交了、或 CommitToBranch 提交成功但建分支失败）。git status 干净不代表没有成果。查不出来时报错
func headUnreachable(wt string) (bool, error) {
	out, err := git(wt, "rev-list", "-n", "1", "HEAD", "--not", "--branches", "--tags", "--remotes")
	if err != nil {
		return false, err
	}
	return trim(out) != "", nil
}

// preserveHead：拆 worktree 前把 HEAD 上独有的提交留在一个新分支上；没有独有提交时什么都不做。
// 返回建的分支名；查不出来或建不成时返回错误——调用方保留目录，不能当作没有成果
func preserveHead(h *IsolationHandle) (string, error) {
	unique, err := headUnreachable(h.WorktreePath)
	if err != nil {
		return "", fmt.Errorf("检查 worktree 的提交失败：%s", err.Error())
	}
	if !unique {
		return "", nil
	}
	b, err := branchAtHead(h)
	if err != nil {
		return "", fmt.Errorf("保存 worktree 里的提交失败：%s", err.Error())
	}
	return b, nil
}

// LandWorktree：worktree 的改动落地：改动多（> LandMaxFiles 个文件或 > LandMaxLines 行）→ 整体提交到新分支；
// 否则拷回当前工作区，拷不回去的（冲突、授权外、复制失败）提交到新分支。编程助手自己提交了、
// 还没有分支指着的提交，拆之前也留在一个新分支上（status 干净不等于没有成果）。落地成功后拆掉 worktree。
func LandWorktree(h *IsolationHandle, changed []string, title string, mayWrite func(dest string) bool) LandResult {
	r := LandResult{Mode: "none", Apply: ApplyResult{Applied: []string{}, Skipped: []string{}, Conflicted: []string{}, Denied: []string{}}}
	if h == nil || h.Kind != IsoWorktree || h.WorktreePath == "" || h.GitRoot == "" || !existsSync(h.WorktreePath) {
		return r
	}
	files := []string{}
	for _, f := range changed {
		if safeRel(f) {
			files = append(files, f)
		} else {
			r.Apply.Skipped = append(r.Apply.Skipped, f)
		}
	}
	if len(files) == 0 {
		b, err := preserveHead(h)
		if err != nil {
			r.Kept, r.Err = true, err.Error()
			return r
		}
		if b != "" {
			r.Mode, r.Branch = "branch", b
		}
		ReleaseIsolation(h, nil)
		return r
	}
	lines, err := diffLines(h.WorktreePath, files)
	big := err != nil || len(files) > LandMaxFiles || lines > LandMaxLines
	rest := files
	if !big {
		r.Mode = "applied"
		ar := ApplyWorktreeToMain(h, files, mayWrite)
		ar.Skipped = append(r.Apply.Skipped, ar.Skipped...)
		r.Apply = ar
		rest = []string{}
		for _, f := range append(append(append([]string{}, ar.Conflicted...), ar.Denied...), ar.Skipped...) {
			if safeRel(f) {
				rest = append(rest, f)
			}
		}
	} else {
		r.Mode = "branch"
	}
	if len(rest) > 0 {
		b, err := CommitToBranch(h, rest, title)
		if err != nil {
			r.Kept, r.Err = true, err.Error()
			return r
		}
		r.Branch = b
	}
	// 拷回的只是未提交的改动；编程助手自己提交的还要留住
	if r.Branch == "" {
		b, err := preserveHead(h)
		if err != nil {
			r.Kept, r.Err = true, err.Error()
			return r
		}
		r.Branch = b
	}
	ReleaseIsolation(h, nil)
	return r
}

// IsDelegateWorktree：路径是委派开的 worktree（<目录>/.nomi-delegate/<id>）
func IsDelegateWorktree(p string) bool {
	return pth.Basename(pth.Dirname(p)) == ".nomi-delegate"
}

// SweepOrphanWorktrees：启动时清理没人认领的委派 worktree：keep(路径) 为真的留着（还在用的任务、用户接手的标签）；
// 有改动的先提交到新分支，已有提交但没有分支指着的也先建分支，然后再拆（提交 / 建分支 / 检查失败就留着）。
// 返回拆掉的路径
func SweepOrphanWorktrees(roots []string, keep func(path string) bool, log func(string)) []string {
	removed := []string{}
	seen := map[string]bool{}
	for _, r := range roots {
		root := ResolveGitRoot(r)
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		out, err := git(root, "worktree", "list", "--porcelain")
		if err != nil {
			continue
		}
		for _, l := range crlfRe.Split(out, -1) {
			p, ok := strings.CutPrefix(l, "worktree ")
			if !ok || !IsDelegateWorktree(p) || (keep != nil && (keep(p) || keep(realPath(p)))) {
				continue
			}
			h := &IsolationHandle{Kind: IsoWorktree, Cwd: p, SourceCwd: p, GitRoot: root, WorktreePath: p}
			if existsSync(p) {
				st, err := git(p, "status", "--porcelain", "--untracked-files=all")
				if err != nil {
					continue
				}
				if trim(st) != "" {
					if _, err := CommitToBranch(h, []string{"."}, "unfinished delegated changes"); err != nil {
						if log != nil {
							log("keep orphan worktree " + p + ": " + err.Error())
						}
						continue
					}
				} else if b, err := preserveHead(h); err != nil {
					if log != nil {
						log("keep orphan worktree " + p + ": " + err.Error())
					}
					continue
				} else if b != "" && log != nil {
					log("orphan worktree " + p + ": kept its commits on " + b)
				}
			}
			ReleaseIsolation(h, log)
			removed = append(removed, p)
		}
		_, _ = git(root, "worktree", "prune")
	}
	return removed
}
