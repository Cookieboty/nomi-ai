package cli

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// spawnSync('taskkill', …, { stdio: 'ignore', timeout: 3000 })：exec.Cmd 的 nil Stdin/Stdout/Stderr 即 'ignore'。
const (
	taskkillTimeoutMs = 3000
	taskkillStdio     = "ignore"
)

// execFileSync / spawnSync 的注入点（测试用 fixture 记录调用）。
var (
	runPgrep = func(pid int) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2000*time.Millisecond)
		defer cancel()
		out, err := exec.CommandContext(ctx, "pgrep", "-P", strconv.Itoa(pid)).Output()
		return string(out), err
	}
	runTaskkill = func(args []string) {
		ctx, cancel := context.WithTimeout(context.Background(), taskkillTimeoutMs*time.Millisecond)
		defer cancel()
		cmd := exec.CommandContext(ctx, "taskkill", args...)
		_ = cmd.Run()
	}
	killPid = func(pid int, sig string) error { return nodeproc.KillPid(pid, sig) }
)

func childrenOf(pid int) []int {
	out, err := runPgrep(pid)
	if err != nil {
		return []int{}
	}
	res := []int{}
	for _, s := range strings.Split(out, "\n") {
		t := strings.TrimSpace(s)
		// Number('') = 0 被 n > 0 过滤；非整数 / NaN 同样过滤
		n, err := strconv.ParseFloat(t, 64)
		if t == "" || err != nil || n != float64(int(n)) || n <= 0 {
			continue
		}
		res = append(res, int(n))
	}
	return res
}

// ListDescendants = listDescendants（后序：子孙在前）。
func ListDescendants(pid, depthLimit int) []int {
	all := []int{}
	var walk func(p, depth int)
	walk = func(p, depth int) {
		if depth > depthLimit {
			return
		}
		for _, c := range childrenOf(p) {
			walk(c, depth+1)
			all = append(all, c)
		}
	}
	walk(pid, 0)
	return all
}

// TreeChild = Pick<ChildProcess, 'pid' | 'kill'>。
type TreeChild interface {
	PID() int
	Kill(signal string) bool
}

// KillProcessTree = killProcessTree。
func KillProcessTree(child TreeChild) {
	safe := func(f func()) { defer func() { _ = recover() }(); f() }
	pid := child.PID()
	if pid == 0 {
		safe(func() { child.Kill("SIGKILL") })
		return
	}
	if usage.Platform() == "win32" {
		safe(func() { runTaskkill([]string{"/pid", strconv.Itoa(pid), "/T", "/F"}) })
		return
	}
	for _, p := range ListDescendants(pid, 8) {
		_ = killPid(p, "SIGKILL")
	}
	safe(func() { child.Kill("SIGKILL") })
}

// NodeChild 把 *nodeproc.Child 适配为 TreeChild。
type NodeChild struct{ *nodeproc.Child }

func (c NodeChild) PID() int { return c.Pid }
