//go:build !windows

package nodeproc

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// lookPath = libuv uv__spawn 的 PATH 查找：用子进程 env 的 PATH（没有则 /usr/bin:/bin），
// 带斜杠的名字相对 cwd，不查找；记住 EACCES（execvp 语义）。
func lookPath(file, cwd string, env []string) (string, error) {
	if strings.Contains(file, "/") {
		p := file
		if !filepath.IsAbs(p) && cwd != "" {
			p = filepath.Join(cwd, p)
		}
		return p, checkExec(p)
	}
	if file == "" {
		return "", errENOENT
	}
	pathEnv, ok := envGet(env, "PATH", false)
	if !ok {
		pathEnv = "/usr/bin:/bin"
	}
	sawEACCES := false
	for _, dir := range strings.Split(pathEnv, ":") {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, file)
		if !filepath.IsAbs(p) && cwd != "" {
			p = filepath.Join(cwd, p)
		}
		err := checkExec(p)
		if err == nil {
			return p, nil
		}
		if errors.Is(err, syscall.EACCES) {
			sawEACCES = true
		}
	}
	if sawEACCES {
		return "", syscall.EACCES
	}
	return "", errENOENT
}

func checkExec(p string) error {
	st, err := os.Stat(p)
	if err != nil {
		return errENOENT
	}
	if st.IsDir() || st.Mode()&0o111 == 0 {
		return syscall.EACCES
	}
	return nil
}

func setSysProcAttr(cmd *exec.Cmd, file, path string, args []string, o Options) {
	if o.Detached {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
}

func errnoOf(err error) int {
	var en syscall.Errno
	if errors.As(err, &en) {
		return -int(en)
	}
	if errors.Is(err, fs.ErrPermission) {
		return -int(syscall.EACCES)
	}
	return -int(syscall.ENOENT)
}

func codeOf(err error) string {
	var en syscall.Errno
	if errors.As(err, &en) {
		switch en {
		case syscall.EACCES:
			return "EACCES"
		case syscall.ENOENT:
			return "ENOENT"
		case syscall.ENOEXEC:
			return "ENOEXEC"
		case syscall.E2BIG:
			return "E2BIG"
		case syscall.ENOTDIR:
			return "ENOTDIR"
		}
		return "UNKNOWN"
	}
	return "ENOENT"
}

var sigByName = map[string]syscall.Signal{
	"SIGTERM": syscall.SIGTERM, "SIGKILL": syscall.SIGKILL, "SIGINT": syscall.SIGINT,
	"SIGHUP": syscall.SIGHUP, "SIGQUIT": syscall.SIGQUIT, "SIGUSR1": syscall.SIGUSR1, "SIGUSR2": syscall.SIGUSR2,
}

// SignalName 信号 → Node 的信号名。
func SignalName(s syscall.Signal) string {
	for k, v := range sigByName {
		if v == s {
			return k
		}
	}
	return "SIG" + strings.ToUpper(s.String())
}

func killProcess(p *os.Process, signal string) error {
	s, ok := sigByName[signal]
	if !ok {
		return errors.New("unknown signal")
	}
	return p.Signal(s)
}

// KillPid = process.kill(pid, signal)。
func KillPid(pid int, signal string) error {
	s, ok := sigByName[signal]
	if !ok {
		s = syscall.SIGTERM
	}
	return syscall.Kill(pid, s)
}

func exitStatus(cmd *exec.Cmd, werr error, _ string) (*int, string) {
	ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus)
	if ok && ws.Signaled() {
		return nil, SignalName(ws.Signal())
	}
	c := cmd.ProcessState.ExitCode()
	return &c, ""
}
