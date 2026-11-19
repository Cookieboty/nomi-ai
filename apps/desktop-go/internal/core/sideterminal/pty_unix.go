//go:build darwin || linux

package sideterminal

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type unixPTY struct {
	mu     sync.Mutex
	master *os.File
	cmd    *exec.Cmd
	pid    int
	shell  string
	done   chan struct{}
	closed bool
	once   sync.Once
}

func startPTY(opts StartOptions) (PTY, error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, err
	}
	cols, rows := clampSize(int(opts.Cols), int(opts.Rows))
	_ = unix.IoctlSetWinsize(int(master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{
		Row: rows,
		Col: cols,
	})

	shellPath, args, shellName := resolveUnixShell()
	cmd := exec.Command(shellPath, args...)
	if opts.Dir != "" {
		cmd.Dir = opts.Dir
	}
	cmd.Env = buildEnv(opts.Env, true)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid:  true,
		Setctty: true,
		Ctty:    0,
	}

	if err := cmd.Start(); err != nil {
		_ = slave.Close()
		_ = master.Close()
		return nil, err
	}
	// 子进程已继承控制终端，父进程必须立即关闭 slave，使子进程退出后 Read 返回 EOF。
	_ = slave.Close()

	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	return &unixPTY{
		master: master,
		cmd:    cmd,
		pid:    pid,
		shell:  shellName,
		done:   make(chan struct{}),
	}, nil
}

func resolveUnixShell() (path string, args []string, name string) {
	var candidates []string
	if envShell := strings.TrimSpace(os.Getenv("SHELL")); envShell != "" {
		candidates = append(candidates, envShell)
	}
	if runtime.GOOS == "darwin" {
		candidates = append(candidates, "/bin/zsh", "/bin/bash", "/bin/sh")
	} else {
		candidates = append(candidates, "/bin/bash", "/bin/zsh", "/bin/sh")
	}

	chosen := "/bin/sh"
	for _, c := range candidates {
		if resolved := checkExecShell(c); resolved != "" {
			chosen = resolved
			break
		}
	}
	base := filepath.Base(chosen)
	if runtime.GOOS == "darwin" && (base == "zsh" || base == "bash" || base == "fish") {
		// macOS 从 Finder / Wails 启动的应用不经过 login shell，用 -l 加载完整开发 PATH。
		return chosen, []string{"-l"}, base
	}
	return chosen, nil, base
}

func checkExecShell(p string) string {
	if !filepath.IsAbs(p) {
		if resolved, err := exec.LookPath(p); err == nil {
			p = resolved
		} else {
			return ""
		}
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
		return ""
	}
	return p
}

func (u *unixPTY) Shell() string {
	return u.shell
}

func (u *unixPTY) Read(p []byte) (int, error) {
	return u.master.Read(p)
}

func (u *unixPTY) Write(p []byte) (int, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return 0, os.ErrClosed
	}
	return u.master.Write(p)
}

func (u *unixPTY) Resize(cols, rows uint16) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return os.ErrClosed
	}
	c, r := clampSize(int(cols), int(rows))
	return unix.IoctlSetWinsize(int(u.master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{
		Row: r,
		Col: c,
	})
}

func (u *unixPTY) Wait() (int, string, error) {
	err := u.cmd.Wait()
	close(u.done)
	if err == nil {
		return 0, "", nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return -1, ws.Signal().String(), err
		}
		return exitErr.ExitCode(), "", nil
	}
	return -1, "", err
}

func (u *unixPTY) Close() error {
	u.once.Do(func() {
		if u.pid > 0 {
			_ = unix.Kill(-u.pid, unix.SIGHUP)
			_ = unix.Kill(-u.pid, unix.SIGTERM)
		}
		u.mu.Lock()
		u.closed = true
		_ = u.master.Close()
		u.mu.Unlock()

		if u.pid > 0 {
			select {
			case <-u.done:
			case <-time.After(500 * time.Millisecond):
				_ = unix.Kill(-u.pid, unix.SIGKILL)
			}
		}
	})
	return nil
}
