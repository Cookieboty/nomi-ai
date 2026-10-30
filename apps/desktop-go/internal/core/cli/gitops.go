package cli

// gitops.go = apps/desktop-electron/internal/core/src/cli/gitOps.ts（变更面板的 git 写操作）。
// 所有导出函数须在 jsrt.Run 内调用（async 语义）：git 子进程期间释放 GIL。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	gitLocalMs  = 8000
	gitHookMs   = 5 * 60_000
	gitNetMs    = 2 * 60_000
	gitOutMax   = 8 * 1024
	gitMaxPaths = 20_000
	gitMaxBuf   = 8 * 1024 * 1024
)

// GitEnv = slashDiscovery.gitEnv。
func GitEnv() *util.Obj {
	env := usage.ProcessEnv()
	env.Set("GIT_OPTIONAL_LOCKS", "0")
	env.Set("GIT_TERMINAL_PROMPT", "0")
	env.Set("GCM_INTERACTIVE", "never")
	env.Set("NO_COLOR", "1")
	for _, k := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"} {
		env.Delete(k)
	}
	return env
}

// GitOpsEnv = gitOpsEnv。
func GitOpsEnv() *util.Obj {
	env := GitEnv()
	env.Delete("GIT_OPTIONAL_LOCKS")
	return env
}

var redactRe = regexp.MustCompile(`://[^/@` + util.JSWhitespace[1:len(util.JSWhitespace)-1] + `]+@`)

// Redact = redact。
func Redact(s string) string { return redactRe.ReplaceAllString(s, "://***@") }

// GitRun = Run。
type GitRun struct {
	Code     int
	Stdout   string
	Stderr   string
	TimedOut bool
}

type capBuf struct {
	bytes.Buffer
	over  bool
	limit int
}

func (c *capBuf) Write(p []byte) (int, error) {
	if c.Len()+len(p) > c.limit {
		c.over = true
		return 0, errors.New("maxBuffer")
	}
	return c.Buffer.Write(p)
}

// gitExecResult：GitRun + Node execFile 回调里 err.message（成功为 ""）与原始 stderr。
type gitExecResult struct {
	GitRun
	err       string
	rawStderr string
}

// gitExecWith = execFile('git', ['--no-pager','-c','core.quotepath=false', …args], {timeout, maxBuffer, env, windowsHide})。
func gitExecWith(cwd string, args []string, timeoutMs int, input string, maxBuf int, env *util.Obj) gitExecResult {
	return execFileGit(cwd, append([]string{"--no-pager", "-c", "core.quotepath=false"}, args...), timeoutMs, input, maxBuf, env, true)
}

// execFileGit = execFile('git', full, …)；hide = windowsHide。
func execFileGit(cwd string, full []string, timeoutMs int, input string, maxBuf int, env *util.Obj, hide bool) gitExecResult {
	failed := "Command failed: git " + strings.Join(full, " ") + "\n"
	cmd := exec.Command("git", full...)
	cmd.Dir = cwd
	cmd.Env = usage.EnvSlice(env)
	if hide {
		hideWindow(cmd)
	}
	cmd.Stdin = strings.NewReader(input)
	so, se := capBuf{limit: maxBuf}, capBuf{limit: maxBuf}
	cmd.Stdout, cmd.Stderr = &so, &se
	if err := cmd.Start(); err != nil {
		msg := "spawn git ENOENT"
		if !errors.Is(err, exec.ErrNotFound) && !errors.Is(err, os.ErrNotExist) {
			msg = err.Error()
			if cmd.Dir != "" {
				if _, e := os.Stat(cmd.Dir); e != nil {
					msg = "spawn git ENOENT"
				}
			}
		}
		return gitExecResult{GitRun: GitRun{Code: -1, Stderr: msg}, err: msg}
	}
	killed := false
	var mu sync.Mutex
	t := time.AfterFunc(time.Duration(timeoutMs)*time.Millisecond, func() {
		mu.Lock()
		killed = true
		mu.Unlock()
		killTerm(cmd.Process)
	})
	err := cmd.Wait()
	t.Stop()
	mu.Lock()
	k := killed
	mu.Unlock()
	raw := charcontract.DecodeUTF8(se.Bytes())
	r := gitExecResult{GitRun: GitRun{Stdout: charcontract.DecodeUTF8(so.Bytes()), Stderr: raw, TimedOut: k}, rawStderr: raw}
	switch {
	case err == nil:
	case so.over || se.over:
		r.Code, r.TimedOut = -1, true
		r.err = "stdout maxBuffer length exceeded"
		if se.over {
			r.err = "stderr maxBuffer length exceeded"
		}
		if r.Stderr == "" {
			r.Stderr = r.err
		}
	default:
		r.err = failed + raw
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() >= 0 && !k {
			r.Code = ee.ExitCode()
		} else {
			r.Code = -1
			if r.Stderr == "" {
				r.Stderr = failed
			}
		}
	}
	return r
}

// GitExec = gitOps 的 execFile('git', …)（可替换，供测试）。
var GitExec = func(cwd string, args []string, timeoutMs int, input string) GitRun {
	return gitExecWith(cwd, args, timeoutMs, input, gitMaxBuf, GitOpsEnv()).GitRun
}

func gitRun(cwd string, args []string, timeoutMs int, input string) GitRun {
	jsrt.Leave()
	defer jsrt.Enter()
	return GitExec(cwd, args, timeoutMs, input)
}

func gitOut(rs ...GitRun) string {
	parts := []string{}
	for _, r := range rs {
		if s := util.JSTrim(r.Stdout + "\n" + r.Stderr); s != "" {
			parts = append(parts, s)
		}
	}
	s := Redact(strings.Join(parts, "\n"))
	if util.UTF16Len(s) > gitOutMax {
		return "…" + clisdk.SliceFrom(s, -gitOutMax)
	}
	return s
}

func gitLine(cwd string, args []string) string {
	r := gitRun(cwd, args, gitLocalMs, "")
	if r.Code == 0 {
		return util.JSTrim(r.Stdout)
	}
	return ""
}

var (
	reAuth     = regexp.MustCompile(`(?i)Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|Invalid username or password`)
	reDiverged = regexp.MustCompile(`(?i)Not possible to fast-forward|diverging branches|have diverged`)
	reDirty    = regexp.MustCompile(`(?i)would be overwritten by merge|commit your changes or stash them`)
	reRejected = regexp.MustCompile(`(?i)\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first`)
	reNothing  = regexp.MustCompile(`(?i)nothing to commit|no changes added to commit|nothing added to commit`)
	reSha      = regexp.MustCompile(`(?i)^[0-9a-f]{40}([0-9a-f]{24})?$`)
	reCRLF     = regexp.MustCompile(`\r\n?`)
	reDelegate = regexp.MustCompile(`[\\/]\.nomi-delegate[\\/][^\\/]+$`)
	reGitdir   = util.JSRe(`(?m)^gitdir:\s*(.+?)\s*$`)
)

// Classify = classify。
func Classify(r GitRun) string {
	if r.TimedOut {
		return "timeout"
	}
	s := r.Stdout + "\n" + r.Stderr
	switch {
	case reAuth.MatchString(s):
		return "auth"
	case reDiverged.MatchString(s):
		return "diverged"
	case reDirty.MatchString(s):
		return "dirty"
	case reRejected.MatchString(s):
		return "rejected"
	}
	return "error"
}

// GitOpResult = GitOpResult 的 JSON 形状（有序 Obj）。
func gitFail(code string, rs ...GitRun) *util.Obj {
	o := util.NewObj("ok", false, "code", code)
	if len(rs) > 0 {
		o.Set("output", gitOut(rs...))
	}
	return o
}

func gitOK() *util.Obj { return util.NewObj("ok", true) }

func timeoutOr(r GitRun, code string) string {
	if r.TimedOut {
		return "timeout"
	}
	return code
}

// gitReal = real（realpath；Windows 用 native；失败 path.resolve）。
func gitReal(p string) string {
	if r, err := realpathNative(p); err == nil {
		return r
	}
	a, _ := filepath.Abs(p)
	return a
}

var (
	runningMu sync.Mutex
	running   = map[string]bool{}
)

func gitLocked(cwd string, fn func() *util.Obj) *util.Obj {
	common := gitLine(cwd, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"})
	if common == "" {
		common = cwd
	}
	key := gitReal(common)
	runningMu.Lock()
	if running[key] {
		runningMu.Unlock()
		return util.NewObj("ok", false, "code", "busy")
	}
	running[key] = true
	runningMu.Unlock()
	defer func() {
		runningMu.Lock()
		delete(running, key)
		runningMu.Unlock()
	}()
	return fn()
}

func isRelOutside(rel string) bool {
	return rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel)
}

// pathRel = path.relative（win32 按小写比较、输出保留 to 的大小写；"" 表示同一路径）。
func pathRel(from, to string) string {
	from, to = resolveFrom(absOf("."), from), resolveFrom(absOf("."), to)
	if runtime.GOOS != "windows" {
		r, err := filepath.Rel(from, to)
		if err != nil {
			return to
		}
		if r == "." {
			return ""
		}
		return r
	}
	r, err := filepath.Rel(strings.ToLower(from), strings.ToLower(to))
	if err != nil {
		return to // 不同盘符：path.relative 返回 to 本身（绝对路径）
	}
	if r == "." {
		return ""
	}
	parts := strings.Split(r, string(filepath.Separator))
	up := 0
	for up < len(parts) && parts[up] == ".." {
		up++
	}
	down := len(parts) - up
	if down == 0 {
		return r
	}
	tp := strings.Split(strings.TrimRight(to, string(filepath.Separator)), string(filepath.Separator))
	if down > len(tp) {
		return r
	}
	return filepath.Join(append(parts[:up:up], tp[len(tp)-down:]...)...)
}

func gitCheckPaths(cwd string, paths any) []string {
	arr, ok := paths.([]any)
	if !ok || len(arr) == 0 || len(arr) > gitMaxPaths {
		return nil
	}
	top := gitLine(cwd, []string{"rev-parse", "--show-toplevel"})
	if top == "" {
		return nil
	}
	base, root := gitReal(cwd), gitReal(top)
	list := []string{}
	for _, v := range arr {
		p, ok := v.(string)
		if !ok || p == "" || util.UTF16Len(p) > 4096 || strings.ContainsRune(p, 0) {
			return nil
		}
		if filepath.IsAbs(p) {
			return nil
		}
		rel := pathRel(root, resolveFrom(base, p))
		if rel == "" || isRelOutside(rel) {
			return nil
		}
		list = append(list, p)
	}
	return list
}

// resolveFrom = path.resolve(base, p)（win32：`\\x` / `/x` 落到 base 的盘符根，`C:x` 按该盘解析）。
func resolveFrom(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if runtime.GOOS == "windows" {
		if v := filepath.VolumeName(p); v != "" {
			a, _ := filepath.Abs(p)
			return a
		}
		if p != "" && (p[0] == '\\' || p[0] == '/') {
			return filepath.Clean(filepath.VolumeName(base) + p)
		}
	}
	return filepath.Join(base, p)
}

func gitInside(root, p string) bool {
	rel := pathRel(root, p)
	return rel == "" || !isRelOutside(rel)
}

func gitHasHead(cwd string) bool {
	return gitRun(cwd, []string{"rev-parse", "--verify", "-q", "HEAD"}, gitLocalMs, "").Code == 0
}

func gitStageRun(cwd string, paths []string) GitRun {
	return gitRun(cwd, []string{"--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"}, gitLocalMs*4, strings.Join(paths, "\x00"))
}

// GitStage = gitStage。
func GitStage(cwd string, paths any) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		list := gitCheckPaths(cwd, paths)
		if list == nil {
			return gitFail("invalid")
		}
		r := gitStageRun(cwd, list)
		if r.Code == 0 {
			return gitOK()
		}
		return gitFail(timeoutOr(r, "error"), r)
	})
}

// GitUnstage = gitUnstage。
func GitUnstage(cwd string, paths any) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		list := gitCheckPaths(cwd, paths)
		if list == nil {
			return gitFail("invalid")
		}
		args := []string{"rm", "--cached", "-r", "-q", "--ignore-unmatch"}
		if gitHasHead(cwd) {
			args = []string{"restore", "--staged"}
		}
		r := gitRun(cwd, append(append([]string{"--literal-pathspecs"}, args...), "--pathspec-from-file=-", "--pathspec-file-nul"), gitLocalMs*4, strings.Join(list, "\x00"))
		if r.Code == 0 {
			return gitOK()
		}
		return gitFail(timeoutOr(r, "error"), r)
	})
}

// GitCommit = gitCommit（paths nil / util.Undefined = 未传，同 TS 的 paths != null：只提交已暂存的）。
func GitCommit(cwd string, message any, paths any) *util.Obj {
	msg := ""
	if s, ok := message.(string); ok {
		msg = util.JSTrim(reCRLF.ReplaceAllString(s, "\n"))
	}
	if msg == "" || util.UTF16Len(msg) > 20_000 {
		return gitFail("invalid")
	}
	return gitLocked(cwd, func() *util.Obj {
		if _, undef := paths.(util.JSUndefined); paths != nil && !undef {
			list := gitCheckPaths(cwd, paths)
			if list == nil {
				return gitFail("invalid")
			}
			if s := gitStageRun(cwd, list); s.Code != 0 {
				return gitFail(timeoutOr(s, "error"), s)
			}
		}
		WaitForShellPath(0)
		r := gitRun(cwd, []string{"commit", "-F", "-"}, gitHookMs, msg+"\n")
		if r.Code != 0 {
			if r.TimedOut {
				return gitFail("timeout", r)
			}
			if reNothing.MatchString(r.Stdout + "\n" + r.Stderr) {
				return gitFail("nothing", r)
			}
			return gitFail("hook", r)
		}
		return util.NewObj("ok", true, "sha", gitLine(cwd, []string{"rev-parse", "HEAD"}), "output", gitOut(r))
	})
}

// GitCommitUndo = gitCommitUndo。
func GitCommitUndo(cwd string, sha any) *util.Obj {
	s, ok := sha.(string)
	if !ok || !reSha.MatchString(s) {
		return gitFail("invalid")
	}
	return gitLocked(cwd, func() *util.Obj {
		if gitLine(cwd, []string{"rev-parse", "HEAD"}) != s {
			return gitFail("moved")
		}
		if gitLine(cwd, []string{"branch", "-r", "--contains", s}) != "" {
			return gitFail("pushed")
		}
		var r GitRun
		if gitRun(cwd, []string{"rev-parse", "--verify", "-q", s + "^"}, gitLocalMs, "").Code == 0 {
			r = gitRun(cwd, []string{"reset", "--soft", "HEAD~1"}, gitLocalMs, "")
		} else {
			r = gitRun(cwd, []string{"update-ref", "-d", "HEAD", s}, gitLocalMs, "")
		}
		if r.Code == 0 {
			return gitOK()
		}
		return gitFail("error", r)
	})
}

func gitBranchOf(cwd string) string {
	return gitLine(cwd, []string{"symbolic-ref", "--short", "-q", "HEAD"})
}

func gitConfig(cwd, key string) string { return gitLine(cwd, []string{"config", "--get", key}) }

func gitRemotesOf(cwd string) []string {
	out := []string{}
	for _, s := range strings.Split(gitLine(cwd, []string{"remote"}), "\n") {
		if s = util.JSTrim(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// "" = undefined
func gitPickPushRemote(cwd, branch string, remotes []string) string {
	named := gitConfig(cwd, "branch."+branch+".pushRemote")
	if named == "" {
		named = gitConfig(cwd, "remote.pushDefault")
	}
	if named != "" && containsStr(remotes, named) {
		return named
	}
	if containsStr(remotes, "origin") {
		return "origin"
	}
	if len(remotes) == 1 && !strings.HasPrefix(remotes[0], "-") {
		return remotes[0]
	}
	return ""
}

type gitUpstream struct{ remote, ref, name string }

func gitUpstreamOf(cwd, branch string) *gitUpstream {
	remote := gitConfig(cwd, "branch."+branch+".remote")
	merge := gitConfig(cwd, "branch."+branch+".merge")
	if remote == "" || remote == "." || strings.HasPrefix(remote, "-") || !strings.HasPrefix(merge, "refs/heads/") {
		return nil
	}
	return &gitUpstream{remote, merge, merge[len("refs/heads/"):]}
}

// GitSyncStatus = gitSyncStatus（nil = null）。
func GitSyncStatus(cwd string) *util.Obj {
	branch := gitBranchOf(cwd)
	remotes := gitRemotesOf(cwd)
	ra := make([]any, len(remotes))
	for i, r := range remotes {
		ra[i] = r
	}
	if branch == "" {
		sha := gitLine(cwd, []string{"rev-parse", "--short", "HEAD"})
		if sha == "" {
			return nil
		}
		return util.NewObj("branch", nil, "detached", sha, "ahead", 0.0, "behind", 0.0, "remotes", ra)
	}
	upstream := gitLine(cwd, []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"})
	if upstream == "" {
		o := util.NewObj("branch", branch, "ahead", 0.0, "behind", 0.0, "remotes", ra)
		if pr := gitPickPushRemote(cwd, branch, remotes); pr != "" {
			o.Set("pushRemote", pr)
		}
		return o
	}
	nums := util.JSRe(`\s+`).Split(gitLine(cwd, []string{"rev-list", "--left-right", "--count", "@{u}...HEAD"}), -1)
	num := func(i int) float64 {
		if i >= len(nums) {
			return 0
		}
		f := util.ToNumber(nums[i])
		if f != f || f == 0 {
			return 0
		}
		return f
	}
	return util.NewObj("branch", branch, "upstream", upstream, "ahead", num(1), "behind", num(0), "remotes", ra)
}

// GitFetch = gitFetch。
func GitFetch(cwd string) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		branch := gitBranchOf(cwd)
		remotes := gitRemotesOf(cwd)
		remote := ""
		if branch != "" {
			if up := gitUpstreamOf(cwd, branch); up != nil {
				remote = up.remote
			} else {
				remote = gitPickPushRemote(cwd, branch, remotes)
			}
		} else if len(remotes) > 0 {
			remote = remotes[0]
		}
		if remote == "" {
			return gitFail("no-remote")
		}
		if strings.HasPrefix(remote, "-") {
			return gitFail("invalid")
		}
		r := gitRun(cwd, []string{"fetch", remote}, gitNetMs, "")
		if r.Code == 0 {
			return gitOK()
		}
		return gitFail(Classify(r), r)
	})
}

// GitPull = gitPull。
func GitPull(cwd string) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		branch := gitBranchOf(cwd)
		if branch == "" {
			return gitFail("detached")
		}
		up := gitUpstreamOf(cwd, branch)
		if up == nil {
			return gitFail("no-upstream")
		}
		f := gitRun(cwd, []string{"fetch", up.remote}, gitNetMs, "")
		if f.Code != 0 {
			return gitFail(Classify(f), f)
		}
		WaitForShellPath(0)
		m := gitRun(cwd, []string{"merge", "--ff-only", "@{u}"}, gitHookMs, "")
		if m.Code == 0 {
			return util.NewObj("ok", true, "output", gitOut(m))
		}
		return gitFail(Classify(m), m)
	})
}

// GitPush = gitPush。
func GitPush(cwd string) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		branch := gitBranchOf(cwd)
		if branch == "" {
			return gitFail("detached")
		}
		var args []string
		if up := gitUpstreamOf(cwd, branch); up != nil {
			if up.name != branch {
				return gitFail("mismatch")
			}
			remote := gitConfig(cwd, "branch."+branch+".pushRemote")
			if remote == "" {
				remote = gitConfig(cwd, "remote.pushDefault")
			}
			if remote == "" {
				remote = up.remote
			}
			if strings.HasPrefix(remote, "-") {
				return gitFail("invalid")
			}
			args = []string{"push", remote, "HEAD:" + up.ref}
		} else {
			remote := gitPickPushRemote(cwd, branch, gitRemotesOf(cwd))
			if remote == "" {
				return gitFail("no-remote")
			}
			args = []string{"push", "-u", remote, "HEAD:refs/heads/" + branch}
		}
		WaitForShellPath(0)
		r := gitRun(cwd, args, gitHookMs, "")
		if r.Code == 0 {
			return util.NewObj("ok", true, "output", gitOut(r))
		}
		return gitFail(Classify(r), r)
	})
}

var blankLineSplit = util.JSRe(`\n\s*\n`)

// ParseWorktrees = parseWorktrees（GitWorktree 为有序 Obj）。
func ParseWorktrees(raw string) []*util.Obj {
	list := []*util.Obj{}
	for _, block := range blankLineSplit.Split(raw, -1) {
		var w *util.Obj
		bare := false
		for _, l := range strings.Split(block, "\n") {
			key, val := l, ""
			if i := strings.IndexByte(l, ' '); i >= 0 {
				key, val = l[:i], l[i+1:]
			}
			switch {
			case key == "worktree":
				w = util.NewObj("path", val)
			case w == nil:
			case key == "HEAD":
				w.Set("head", val)
			case key == "branch":
				w.Set("branch", strings.TrimPrefix(val, "refs/heads/"))
			case key == "detached":
				w.Set("detached", true)
			case key == "bare":
				bare = true
			case key == "locked":
				w.Set("locked", true)
			case key == "prunable":
				w.Set("prunable", true)
			}
		}
		if w != nil && !bare {
			list = append(list, w)
		}
	}
	return list
}

// GitWorktrees = gitWorktrees（nil = null）。
func GitWorktrees(cwd string) *util.Obj {
	top := gitLine(cwd, []string{"rev-parse", "--show-toplevel"})
	if top == "" {
		return nil
	}
	dirs := strings.Split(gitLine(cwd, []string{"rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"}), "\n")
	gitDir := dirs[0]
	commonDir := ""
	if len(dirs) > 1 {
		commonDir = dirs[1]
	}
	r := gitRun(cwd, []string{"worktree", "list", "--porcelain"}, gitLocalMs, "")
	here := gitReal(top)
	var ws []*util.Obj
	if r.Code == 0 {
		ws = ParseWorktrees(r.Stdout)
	} else {
		ws = []*util.Obj{util.NewObj("path", top)}
	}
	out := []any{}
	for i, w := range ws {
		o := w.Clone()
		p := w.Get("path").(string)
		if i == 0 {
			o.Set("main", true)
		}
		if gitReal(p) == here {
			o.Set("current", true)
		}
		if reDelegate.MatchString(p) {
			o.Set("delegate", true)
		}
		out = append(out, o)
	}
	return util.NewObj("linked", gitDir != "" && commonDir != "" && gitReal(gitDir) != gitReal(commonDir), "worktrees", out)
}

// OwnedWorktrees = ownedWorktrees。
func OwnedWorktrees(cwd string, worktrees []*util.Obj) []string {
	owned := []string{}
	common := gitLine(cwd, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"})
	if common == "" {
		return owned
	}
	want := gitReal(common)
	for _, w := range worktrees {
		if w.Get("prunable") == true {
			continue
		}
		wp, _ := w.Get("path").(string)
		dotgit := filepath.Join(wp, ".git")
		st, err := os.Lstat(dotgit)
		if err != nil {
			continue
		}
		switch {
		case st.IsDir():
			if gitReal(dotgit) != want {
				continue
			}
		case st.Mode().IsRegular():
			b, err := os.ReadFile(dotgit)
			if err != nil {
				continue
			}
			m := reGitdir.FindStringSubmatch(strings.ToValidUTF8(string(b), "\uFFFD"))
			if m == nil {
				continue
			}
			gd := gitReal(resolveFrom(absOf(wp), m[1]))
			if filepath.Dir(gd) != filepath.Join(want, "worktrees") {
				continue
			}
		default:
			continue
		}
		if c := gitLine(wp, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"}); c != "" && gitReal(c) == want {
			owned = append(owned, wp)
		}
	}
	return owned
}

func absOf(p string) string { a, _ := filepath.Abs(p); return a }

const (
	contextDiffMax  = 24_000
	untrackedPeek   = 1500
	untrackedMax    = 10
	contextPathsMax = 300
	discardTag      = "nomi: discard"
)

// GitCommitContextOf = gitCommitContext（nil = null）。
func GitCommitContextOf(cwd string, paths any) *GitCommitContext {
	flags := []string{"--no-ext-diff", "--no-textconv", "--no-color"}
	subjects := splitNonEmpty(gitLine(cwd, []string{"log", "-10", "--format=%s"}), "\n")
	var stat, diff string
	if paths == nil {
		stat = gitLine(cwd, append(append([]string{"diff"}, flags...), "--cached", "--stat"))
		diff = gitRun(cwd, append(append([]string{"diff"}, flags...), "--cached"), gitLocalMs, "").Stdout
	} else {
		all := gitCheckPaths(cwd, paths)
		if all == nil {
			return nil
		}
		list := all
		if len(list) > contextPathsMax {
			list = list[:contextPathsMax]
		}
		head := []string{"--cached"}
		if gitHasHead(cwd) {
			head = []string{"HEAD"}
		}
		cat := func(parts ...[]string) []string {
			out := []string{}
			for _, p := range parts {
				out = append(out, p...)
			}
			return out
		}
		spec := []string{"--literal-pathspecs"}
		stat = gitLine(cwd, cat(spec, []string{"diff"}, flags, []string{"--stat"}, head, []string{"--"}, list))
		diff = gitRun(cwd, cat(spec, []string{"diff"}, flags, head, []string{"--"}, list), gitLocalMs, "").Stdout
		untracked := splitNonEmpty(gitLine(cwd, cat(spec, []string{"ls-files", "--others", "--exclude-standard", "--"}, list)), "\n")
		base := gitReal(cwd)
		top := gitReal(gitLine(cwd, []string{"rev-parse", "--show-toplevel"}))
		peeks := []string{}
		for i, f := range untracked {
			if i >= untrackedMax {
				break
			}
			peeks = append(peeks, func() string {
				head := ""
				file := resolveFrom(base, f)
				st, err := os.Lstat(file)
				if err != nil {
					return "new file: " + f + "\n" + head
				}
				if st.Mode()&os.ModeSymlink != 0 || isJunctionInfo(st) {
					return "new file: " + f + "\n(symlink)"
				}
				if !st.Mode().IsRegular() || !gitInside(top, gitReal(file)) {
					return "new file: " + f
				}
				b, err := os.ReadFile(file)
				if err != nil {
					return "new file: " + f + "\n" + head
				}
				if len(b) > untrackedPeek {
					b = b[:untrackedPeek]
				}
				if bytes.IndexByte(b, 0) >= 0 {
					head = "(binary)"
				} else {
					head = strings.ToValidUTF8(string(b), "\uFFFD")
				}
				return "new file: " + f + "\n" + head
			}())
		}
		if len(untracked) > untrackedMax {
			peeks = append(peeks, "… "+strconv.Itoa(len(untracked)-untrackedMax)+" more new files")
		}
		if len(untracked) > 0 {
			sp := []string{}
			if stat != "" {
				sp = append(sp, stat)
			}
			for _, f := range untracked {
				sp = append(sp, " "+f+" (new)")
			}
			stat = strings.Join(sp, "\n")
			dp := []string{}
			if diff != "" {
				dp = append(dp, diff)
			}
			for _, p := range peeks {
				if p != "" {
					dp = append(dp, p)
				}
			}
			diff = strings.Join(dp, "\n")
		}
	}
	n := util.UTF16Len(diff)
	truncated := n > contextDiffMax
	if truncated {
		diff = clisdk.Slice0(diff, contextDiffMax)
	}
	return &GitCommitContext{Subjects: subjects, Stat: stat, Diff: diff, Truncated: truncated}
}

func worktreeTag(top string) string {
	h := sha256.Sum256([]byte(top))
	return "[wt:" + hex.EncodeToString(h[:])[:12] + "]"
}

func gitStashPush(cwd string, args, paths []string, label string) (GitRun, string) {
	before := gitLine(cwd, []string{"rev-parse", "-q", "--verify", "refs/stash"})
	a := append([]string{"--literal-pathspecs", "stash", "push"}, args...)
	a = append(a, "-m", label, "--pathspec-from-file=-", "--pathspec-file-nul")
	r := gitRun(cwd, a, gitLocalMs*4, strings.Join(paths, "\x00"))
	sha := gitLine(cwd, []string{"rev-parse", "-q", "--verify", "refs/stash"})
	if sha != "" && sha != before {
		return r, sha
	}
	return r, ""
}

// GitDiscard = gitDiscard（成功带 stashes）。
func GitDiscard(cwd string, paths any) *util.Obj {
	return gitLocked(cwd, func() *util.Obj {
		list := gitCheckPaths(cwd, paths)
		if list == nil {
			return gitFail("invalid")
		}
		if !gitHasHead(cwd) {
			return gitFail("invalid")
		}
		top := gitReal(gitLine(cwd, []string{"rev-parse", "--show-toplevel"}))
		othersList := []string{}
		others := map[string]bool{}
		for _, f := range splitNonEmpty(gitRun(top, []string{"ls-files", "--others", "--exclude-standard", "-z"}, gitLocalMs, "").Stdout, "\x00") {
			a := resolveFrom(top, f)
			if !others[a] {
				others[a] = true
				othersList = append(othersList, a)
			}
		}
		base := gitReal(cwd)
		sep := string(filepath.Separator)
		hasUntracked := func(p string) bool {
			abs := resolveFrom(base, p)
			if others[abs] {
				return true
			}
			pre := abs + sep
			for _, f := range othersList {
				if strings.HasPrefix(f, pre) {
					return true
				}
			}
			return false
		}
		untracked, dirs := []string{}, []string{}
		for _, p := range list {
			if hasUntracked(p) {
				untracked = append(untracked, p)
				if !others[resolveFrom(base, p)] {
					dirs = append(dirs, p)
				}
			}
		}
		mixed := map[string]bool{}
		for k := 0; k < len(dirs); k += 200 {
			batch := dirs[k:min(k+200, len(dirs))]
			r := gitRun(cwd, append([]string{"--literal-pathspecs", "ls-files", "-z", "--cached", "--"}, batch...), gitLocalMs, "")
			if r.Code != 0 {
				return gitFail("error", r)
			}
			known := []string{}
			for _, f := range splitNonEmpty(r.Stdout, "\x00") {
				known = append(known, resolveFrom(base, f))
			}
			for _, p := range batch {
				pre := resolveFrom(base, p) + sep
				for _, f := range known {
					if strings.HasPrefix(f, pre) {
						mixed[p] = true
						break
					}
				}
			}
		}
		tracked := []string{}
		for _, p := range list {
			if !containsStr(untracked, p) || mixed[p] {
				tracked = append(tracked, p)
			}
		}
		label := discardTag + " " + strconv.Itoa(len(list)) + " " + worktreeTag(top)
		stashes := []any{}
		if len(tracked) > 0 {
			r, sha := gitStashPush(cwd, []string{"--keep-index"}, tracked, label)
			if r.Code != 0 {
				return gitFail(timeoutOr(r, "error"), r)
			}
			if sha != "" {
				stashes = append(stashes, sha)
			}
		}
		if len(untracked) > 0 {
			r, sha := gitStashPush(cwd, []string{"--include-untracked"}, untracked, label)
			if r.Code != 0 {
				o := gitFail(timeoutOr(r, "error"), r)
				o.Set("stashes", stashes)
				return o
			}
			if sha != "" {
				stashes = append(stashes, sha)
			}
		}
		if len(stashes) > 0 {
			return util.NewObj("ok", true, "stashes", stashes)
		}
		return gitFail("nothing")
	})
}

func gitStashIndex(cwd, sha string) int {
	for i, s := range strings.Split(gitLine(cwd, []string{"stash", "list", "--format=%H"}), "\n") {
		if s == sha {
			return i
		}
	}
	return -1
}

// GitDiscardUndo = gitDiscardUndo（stashes 为 string 或数组）。
func GitDiscardUndo(cwd string, stashes any) *util.Obj {
	list, ok := stashes.([]any)
	if !ok {
		list = []any{stashes}
	}
	if len(list) == 0 || len(list) > 2 {
		return gitFail("invalid")
	}
	shas := []string{}
	for _, s := range list {
		str, ok := s.(string)
		if !ok || !reSha.MatchString(str) {
			return gitFail("invalid")
		}
		shas = append(shas, str)
	}
	return gitLocked(cwd, func() *util.Obj {
		top := gitReal(gitLine(cwd, []string{"rev-parse", "--show-toplevel"}))
		for _, sha := range shas {
			if gitStashIndex(top, sha) < 0 {
				return gitFail("moved")
			}
		}
		tag := worktreeTag(top)
		for _, sha := range shas {
			if !strings.Contains(gitLine(top, []string{"log", "-1", "--format=%s", sha}), tag) {
				return gitFail("mismatch")
			}
		}
		for _, sha := range shas {
			if gitRun(top, []string{"rev-parse", "-q", "--verify", sha + "^3"}, gitLocalMs, "").Code == 0 {
				r := gitRun(top, []string{"stash", "pop", "-q", "stash@{" + strconv.Itoa(gitStashIndex(top, sha)) + "}"}, gitLocalMs, "")
				if r.Code != 0 {
					return gitFail("error", r)
				}
				continue
			}
			changes := strings.Split(gitRun(top, []string{"diff", "--name-status", "-z", "--no-renames", sha + "^2", sha}, gitLocalMs, "").Stdout, "\x00")
			restore, remove := []string{}, []string{}
			for i := 0; i+1 < len(changes); i += 2 {
				st, f := changes[i], changes[i+1]
				if f == "" {
					continue
				}
				if st == "D" {
					remove = append(remove, f)
				} else {
					restore = append(restore, f)
				}
			}
			all := append(append([]string{}, restore...), remove...)
			for k := 0; k < len(all); k += 200 {
				dirty := gitRun(top, append([]string{"--literal-pathspecs", "diff", "--name-only", "--"}, all[k:min(k+200, len(all))]...), gitLocalMs, "")
				if dirty.Code != 0 {
					return gitFail("error", dirty)
				}
				if util.JSTrim(dirty.Stdout) != "" {
					return gitFail("moved", dirty)
				}
			}
			if len(restore) > 0 {
				r := gitRun(top, []string{"--literal-pathspecs", "restore", "--source=" + sha, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"}, gitLocalMs*4, strings.Join(restore, "\x00"))
				if r.Code != 0 {
					return gitFail("error", r)
				}
			}
			for _, f := range remove {
				file := resolveFrom(top, f)
				if !gitInside(top, gitReal(filepath.Dir(file))) {
					return gitFail("invalid")
				}
				_ = os.Remove(file) // rmSync force（文件；不存在忽略）
			}
			d := gitRun(top, []string{"stash", "drop", "-q", "stash@{" + strconv.Itoa(gitStashIndex(top, sha)) + "}"}, gitLocalMs, "")
			if d.Code != 0 {
				return gitFail("error", d)
			}
		}
		return gitOK()
	})
}
