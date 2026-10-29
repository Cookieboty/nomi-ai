package nodeproc

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"time"
)

// ErrTimedOut = spawnSync 的 ETIMEDOUT（超时后以 killSignal 结束子进程）。
var ErrTimedOut = errors.New("ETIMEDOUT")

// ExitError = execFileSync / execFile 的非零退出（code 或 signal）。
type ExitError struct {
	Code   *int
	Signal string
}

func (e *ExitError) Error() string { return "Command failed" }

// RunSync = execFileSync / spawnSync 的阻塞版本（不经 jsrt；与 Spawn 相同的 PATH 解析与 Windows 命令行拼法）。
// stdout 原样返回；stderr 丢弃（stdio ignore/pipe 均不影响调用方）。timeout 0 = 不限。
func RunSync(file string, args []string, o Options, timeout time.Duration) ([]byte, error) {
	env := o.Env
	if env == nil {
		env = os.Environ()
	}
	path, err := lookPath(file, o.Cwd, env)
	if err != nil {
		return nil, &SpawnError{Code: codeOf(err), Errno: errnoOf(err), Syscall: "spawnSync " + file, Path: file}
	}
	cmd := exec.Command(path, args...)
	cmd.Args = append([]string{file}, args...)
	cmd.Dir = o.Cwd
	cmd.Env = env
	setSysProcAttr(cmd, file, path, args, o)
	var out bytes.Buffer
	if !o.IgnoreStdout {
		cmd.Stdout = &out
	}
	if err := cmd.Start(); err != nil {
		return nil, &SpawnError{Code: codeOf(err), Errno: errnoOf(err), Syscall: "spawnSync " + file, Path: file}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var timer <-chan time.Time
	if timeout > 0 {
		timer = time.After(timeout)
	}
	select {
	case werr := <-done:
		code, sig := exitStatus(cmd, werr, "")
		if sig != "" || (code != nil && *code != 0) {
			return out.Bytes(), &ExitError{Code: code, Signal: sig}
		}
		return out.Bytes(), nil
	case <-timer:
		_ = killProcess(cmd.Process, "SIGTERM")
		<-done
		return out.Bytes(), ErrTimedOut
	}
}
