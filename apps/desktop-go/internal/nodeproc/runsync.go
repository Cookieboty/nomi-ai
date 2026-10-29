package nodeproc

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"sync"
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
	} else {
		env = libuvEnv(env)
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

// ErrMaxBuffer = execFile 的 ERR_CHILD_PROCESS_STDIO_MAXBUFFER（超限后结束子进程，输出截到 maxBuffer）。
var ErrMaxBuffer = errors.New("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")

type capWriter struct {
	buf  bytes.Buffer
	max  int
	over chan struct{}
	once *sync.Once
}

func (w *capWriter) Write(p []byte) (int, error) {
	if w.max > 0 && w.buf.Len()+len(p) > w.max {
		w.buf.Write(p[:w.max-w.buf.Len()])
		w.once.Do(func() { close(w.over) })
		return len(p), nil
	}
	return w.buf.Write(p)
}

// ExecFile = execFile(file, args, {timeout, maxBuffer}) 的阻塞版本：分别返回 stdout / stderr（各自按 maxBuffer 截断）。
// err：*SpawnError（启动失败）/ *ExitError（非零退出）/ ErrTimedOut / ErrMaxBuffer。
func ExecFile(file string, args []string, o Options, timeout time.Duration, maxBuffer int) (stdout, stderr []byte, err error) {
	env := o.Env
	if env == nil {
		env = os.Environ()
	} else {
		env = libuvEnv(env)
	}
	path, lerr := lookPath(file, o.Cwd, env)
	if lerr != nil {
		return nil, nil, &SpawnError{Code: codeOf(lerr), Errno: errnoOf(lerr), Syscall: "spawn " + file, Path: file}
	}
	cmd := exec.Command(path, args...)
	cmd.Args = append([]string{file}, args...)
	cmd.Dir = o.Cwd
	cmd.Env = env
	setSysProcAttr(cmd, file, path, args, o)
	over := make(chan struct{})
	once := &sync.Once{}
	so := &capWriter{max: maxBuffer, over: over, once: once}
	se := &capWriter{max: maxBuffer, over: over, once: once}
	cmd.Stdout, cmd.Stderr = so, se
	if serr := cmd.Start(); serr != nil {
		return nil, nil, &SpawnError{Code: codeOf(serr), Errno: errnoOf(serr), Syscall: "spawn " + file, Path: file}
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
			return so.buf.Bytes(), se.buf.Bytes(), &ExitError{Code: code, Signal: sig}
		}
		return so.buf.Bytes(), se.buf.Bytes(), nil
	case <-over:
		_ = killProcess(cmd.Process, "SIGTERM")
		<-done
		return so.buf.Bytes(), se.buf.Bytes(), ErrMaxBuffer
	case <-timer:
		_ = killProcess(cmd.Process, "SIGTERM")
		<-done
		return so.buf.Bytes(), se.buf.Bytes(), ErrTimedOut
	}
}
