package cli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/usage"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const (
	pathStart      = "__NOMI_PATH_START__"
	pathEnd        = "__NOMI_PATH_END__"
	shellTimeoutMs = 4000
)

// ParseShellPath = parseShellPath（"" = null）。
func ParseShellPath(out string) string {
	i := strings.LastIndex(out, pathStart)
	if i < 0 {
		return ""
	}
	rest := out[i+len(pathStart):]
	j := strings.Index(rest, pathEnd)
	if j < 0 {
		return ""
	}
	return util.JSTrim(rest[:j])
}

// MergePath = mergePath（delimiter "" = path.delimiter）。
func MergePath(cur, extra, delimiter string) string {
	if delimiter == "" {
		delimiter = string(os.PathListSeparator)
	}
	seen := map[string]bool{}
	out := []string{}
	for _, d := range append(strings.Split(cur, delimiter), strings.Split(extra, delimiter)...) {
		dir := util.JSTrim(d)
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		out = append(out, dir)
	}
	return strings.Join(out, delimiter)
}

// LoginShellArgs = LOGIN_SHELL_ARGS。
var LoginShellArgs = []string{"-ilc", `printf '%s' "` + pathStart + `${PATH}` + pathEnd + `"`}

// ShellPathRunner：执行登录 shell 并取出 PATH（"" = null）。
type ShellPathRunner func(shell string, args []string) string

func readLoginShellPath(shell string, args []string, timeoutMs int) string {
	if timeoutMs == 0 {
		timeoutMs = shellTimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, args...)
	env := usage.ProcessEnv()
	env.Set("DISABLE_AUTO_UPDATE", "true")
	env.Set("ZSH_DISABLE_COMPFIX", "true")
	cmd.Env = usage.EnvSlice(env)
	cmd.Cancel = func() error { return cmd.Process.Signal(sigterm) } // execFile timeout 默认 killSignal SIGTERM
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	return ParseShellPath(string(out))
}

var (
	shellMu    sync.Mutex
	shellReady *jsrt.Promise[struct{}]
)

// LoadLoginShellPathOpts：测试注入。
type LoadLoginShellPathOpts struct {
	Run       ShellPathRunner
	TimeoutMs int
}

// LoadLoginShellPath = loadLoginShellPath（幂等；返回的 Promise 不会 reject）。
func LoadLoginShellPath(onMerged func(added []string), opts LoadLoginShellPathOpts) *jsrt.Promise[struct{}] {
	shellMu.Lock()
	defer shellMu.Unlock()
	if shellReady != nil {
		return shellReady
	}
	if usage.Platform() == "win32" {
		shellReady = jsrt.Resolved(struct{}{})
		return shellReady
	}
	shell := util.JSTrim(os.Getenv("SHELL"))
	if shell == "" {
		if usage.Platform() == "darwin" {
			shell = "/bin/zsh"
		} else {
			shell = "/bin/sh"
		}
	}
	run := opts.Run
	if run == nil {
		to := opts.TimeoutMs
		run = func(sh string, args []string) string { return readLoginShellPath(sh, args, to) }
	}
	p := jsrt.NewPromise[struct{}]()
	shellReady = p
	go func() {
		value := ""
		func() { defer func() { _ = recover() }(); value = run(shell, LoginShellArgs) }()
		jsrt.Run(func() {
			defer p.Resolve(struct{}{})
			defer func() { _ = recover() }()
			if value == "" {
				return
			}
			before := os.Getenv("PATH")
			merged := MergePath(before, value, "")
			if merged == before {
				return
			}
			had := map[string]bool{}
			for _, d := range filepath.SplitList(before) {
				had[d] = true
			}
			_ = os.Setenv("PATH", merged)
			if onMerged != nil {
				added := []string{}
				for _, d := range strings.Split(merged, string(os.PathListSeparator)) {
					if !had[d] {
						added = append(added, d)
					}
				}
				onMerged(added)
			}
		})
	}()
	return p
}

// WaitForShellPath = waitForShellPath（ms 0 = TIMEOUT_MS + 500）。须在 jsrt 线程内调用。
func WaitForShellPath(ms int) {
	shellMu.Lock()
	r := shellReady
	shellMu.Unlock()
	if r == nil {
		return
	}
	if ms == 0 {
		ms = shellTimeoutMs + 500
	}
	race := jsrt.NewPromise[struct{}]()
	t := jsrt.SetTimeout(time.Duration(ms)*time.Millisecond, func() { race.Resolve(struct{}{}) })
	go func() {
		select {
		case <-r.Done():
			jsrt.Run(func() { race.Resolve(struct{}{}) })
		case <-race.Done():
		}
	}()
	_, _ = jsrt.Await(race)
	jsrt.ClearTimeout(t)
}

// ResetShellPathForTest = resetShellPathForTest。
func ResetShellPathForTest() {
	shellMu.Lock()
	shellReady = nil
	shellMu.Unlock()
}
