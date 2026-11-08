package igtools

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/outcap"
)

// RunOutputCap：stdout / stderr 各自最多留多少字给模型（超出时保留开头与结尾，中间省略）。
// 每次调用的输出都进上下文、之后每一步都带着：30k 字约 1 万 token，与 Claude Code 的 Bash 输出上限相当
const RunOutputCap = 30_000

type RunShellOpts struct {
	Cwd       string
	Env       []string
	TimeoutMs int
	Signal    context.Context
	Cap       int
	Shell     func() ShellSpec
}

type RunOutcome struct {
	ExitCode                     *int
	Signal, Stdout, Stderr       string
	TimedOut, Aborted, Truncated bool
	Ms                           int64
}

func defaultShell() ShellSpec {
	if runtime.GOOS == "windows" {
		f := os.Getenv("ComSpec")
		if f == "" {
			f = "cmd.exe"
		}
		return ShellSpec{File: f, Args: func(c string) []string { return []string{"/d", "/s", "/c", "\"" + c + "\""} }, Verbatim: true}
	}
	sh := strings.TrimSpace(os.Getenv("SHELL"))
	if sh == "" {
		sh = "/bin/sh"
		if runtime.GOOS == "darwin" {
			sh = "/bin/zsh"
		}
	}
	return ShellSpec{File: sh, Args: func(c string) []string { return []string{"-c", c} }}
}

// capBuf：超过上限时保留开头与结尾（报错、失败的用例常在结尾），中间省略（outcap）
type capBuf struct {
	mu        *sync.Mutex
	buf       *outcap.Buf
	truncated *bool
}

func newCapBuf(mu *sync.Mutex, capN int, truncated *bool) *capBuf {
	return &capBuf{mu: mu, buf: outcap.New(capN), truncated: truncated}
}

func (b *capBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf.Add(string(p))
	if b.buf.Truncated {
		*b.truncated = true
	}
	return len(p), nil
}

// RunShellCommand = runShellCommand（非 Windows 独立进程组，超时 / 中止 SIGKILL 整组）
func RunShellCommand(command string, o RunShellOpts) RunOutcome {
	capN := o.Cap
	if capN == 0 {
		capN = RunOutputCap
	}
	mk := o.Shell
	if mk == nil {
		mk = defaultShell
	}
	sh := mk()
	t0 := time.Now()
	var mu sync.Mutex
	var out RunOutcome
	so := newCapBuf(&mu, capN, &out.Truncated)
	se := newCapBuf(&mu, capN, &out.Truncated)
	cmd := exec.Command(sh.File, sh.Args(command)...)
	cmd.Dir, cmd.Env, cmd.Stdout, cmd.Stderr, cmd.Stdin = o.Cwd, o.Env, so, se, nil
	setProcAttrs(cmd, sh, command)
	finish := func(err error) RunOutcome {
		mu.Lock()
		defer mu.Unlock()
		out.Stdout, out.Stderr = so.buf.String(), se.buf.String()
		if err != nil {
			if out.Stderr != "" {
				out.Stderr += "\n"
			}
			out.Stderr += err.Error()
		}
		out.Ms = time.Since(t0).Milliseconds()
		return out
	}
	// 命令把子进程放进新会话（setsid / 守护化）时 killTree 杀不到，它仍占着输出管道：超时 / 中止后最多再等 2 秒
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		return finish(spawnErr(err, sh.File))
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(time.Duration(o.TimeoutMs) * time.Millisecond)
	defer timer.Stop()
	var abort <-chan struct{}
	if o.Signal != nil {
		abort = o.Signal.Done()
	}
	var werr error
loop:
	for {
		select {
		case werr = <-done:
			break loop
		case <-timer.C:
			mu.Lock()
			out.TimedOut = true
			mu.Unlock()
			killTree(cmd)
		case <-abort:
			mu.Lock()
			out.Aborted = true
			mu.Unlock()
			abort = nil
			killTree(cmd)
		}
	}
	if st, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && exitSignal(st) != "" {
		out.Signal = exitSignal(st)
	} else if cmd.ProcessState != nil {
		c := cmd.ProcessState.ExitCode()
		out.ExitCode = &c
	}
	var ee *exec.ExitError
	if werr != nil && !errors.As(werr, &ee) && !errors.Is(werr, io.EOF) {
		return finish(werr)
	}
	return finish(nil)
}

// spawn ENOENT 文案（spawn <file> ENOENT）
func spawnErr(err error, file string) error {
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, exec.ErrNotFound) {
		return errors.New("spawn " + file + " ENOENT")
	}
	return err
}
