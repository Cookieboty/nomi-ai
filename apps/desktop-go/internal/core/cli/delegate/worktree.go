package delegate

// worktree.ts：P3 委派 OS 隔离（轻量）：git worktree，避免并行子任务改同一工作区。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	tr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodepath"
)

// MaxParallelDelegates：同时处于 running 的委派上限（含 worktree / shared-cwd）
const MaxParallelDelegates = 3

var pth = nodepath.Lib(nodepath.Platform())

// IsolationHandle：{ kind, cwd, sourceCwd, gitRoot?, worktreePath?, note }（JSON 键序同 Node）
type IsolationHandle struct {
	Kind         string `json:"kind"`
	Cwd          string `json:"cwd"`
	SourceCwd    string `json:"sourceCwd"`
	GitRoot      string `json:"gitRoot,omitempty"`
	WorktreePath string `json:"worktreePath,omitempty"`
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
	o.Set("note", h.Note)
	return o
}

// 持久化的 isolation 原样读回（worktree.ts 只读这几个字段）
func isolationFromObj(o *util.Obj) *IsolationHandle {
	return &IsolationHandle{
		Kind: util.Str(o.Get("kind")), Cwd: util.Str(o.Get("cwd")), SourceCwd: util.Str(o.Get("sourceCwd")),
		GitRoot: util.Str(o.Get("gitRoot")), WorktreePath: util.Str(o.Get("worktreePath")), Note: util.Str(o.Get("note")),
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

var emptyHeadRe = regexp.MustCompile(`(?i)invalid reference:` + `[\t\n\v\f\r \x{a0}\x{feff}\x{2028}\x{2029}\p{Zs}]*` + `HEAD|unknown revision|bad revision|ambiguous argument ['"]HEAD['"]`)

func sharedCwd(sourceCwd string) *IsolationHandle {
	return &IsolationHandle{Kind: "shared-cwd", Cwd: sourceCwd, SourceCwd: sourceCwd,
		Note: tr.T("electron.common.the-working-directory-is-not-a-git-repository") + tr.T("electron.common.hand-off-tasks-one-at-a-time-or")}
}

func existsSync(p string) bool { _, err := os.Stat(p); return err == nil }

// PrepareIsolation：git 仓库内新建 worktree（detached HEAD，`<sourceCwd>/.nomi-delegate/<id>`）；非 git → shared-cwd
func PrepareIsolation(sourceCwd, taskKey string) (*IsolationHandle, error) {
	root := ResolveGitRoot(sourceCwd)
	if root == "" {
		return sharedCwd(sourceCwd), nil
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
	if _, err := git(root, "worktree", "add", "--detach", wt, "HEAD"); err != nil {
		msg := err.Error()
		if emptyHeadRe.MatchString(msg) {
			_ = os.RemoveAll(wt)
			return sharedCwd(sourceCwd), nil
		}
		return nil, fmt.Errorf("无法创建委派 worktree：%s", msg)
	}
	return &IsolationHandle{Kind: "worktree", Cwd: wt, SourceCwd: sourceCwd, GitRoot: root, WorktreePath: wt,
		Note: "已在 git worktree 中隔离并行写入：" + wt}, nil
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
