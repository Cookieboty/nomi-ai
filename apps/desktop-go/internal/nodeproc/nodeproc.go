// Package nodeproc 复刻 Node child_process.spawn（libuv）的可观察行为：
// 按子进程 env 的 PATH 查找可执行文件（Windows：cwd 优先、.com/.exe、不跑 .cmd）、
// 'error'（spawn <file> ENOENT）后 'close'(-errno, null)、被信号杀死 close(null, 'SIGTERM')、
// stdout/stderr 按块回调（每块独立 UTF-8 解码，同 Buffer.toString('utf8')），
// 回调都在 jsrt 锁内执行（= Node 主线程）。
package nodeproc

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// Options = spawn 的 options 子集（被移植代码用到的）。
type Options struct {
	Cwd string
	Env []string // nil = 继承 process.env
	// WindowsVerbatimArguments：参数原样拼进命令行（cmd.exe /d /s /c "..."）
	Verbatim bool
	// Detached（Unix：新进程组 setsid；Windows：DETACHED_PROCESS）
	Detached bool
	// Stdio "ignore" 的流（0/1/2）
	IgnoreStdin, IgnoreStdout, IgnoreStderr bool
}

// SpawnError = Node 的 spawn 错误（err.code / err.errno / err.syscall / err.path / err.message）。
type SpawnError struct {
	Code    string
	Errno   int
	Syscall string
	Path    string
}

func (e *SpawnError) Error() string { return e.Syscall + " " + e.Path + " " + e.Code }

// Stdin = child.stdin（Writable）。
type Stdin struct {
	c        *Child
	w        io.WriteCloser
	writable bool
	mu       sync.Mutex
	queue    chan []byte
}

func (s *Stdin) Writable() bool { return s != nil && s.writable }

// Write 异步写（与 Node 一样不阻塞调用方；EPIPE 等错误被吞，见 spawn.ts 的 stdin.on('error')）。
func (s *Stdin) Write(chunk string) bool {
	if s == nil || !s.writable {
		return false
	}
	s.queue <- []byte(chunk)
	return true
}

// End = stdin.end()：写完排队的数据后关闭。
func (s *Stdin) End() {
	if s == nil || !s.writable {
		return
	}
	s.writable = false
	close(s.queue)
}

// Child = ChildProcess。所有方法持 jsrt 锁调用。
type Child struct {
	Pid        int
	exitCode   *int
	signalCode string
	killed     bool
	termSignal string // Windows：libuv 记下发出的信号，退出时报 (null, signal)
	Stdin      *Stdin
	cmd        *exec.Cmd

	onStdout, onStderr []func(string)
	onClose            []func(code *int, signal string)
	onError            []func(error)
	onExit             []func(code *int, signal string)
}

func (c *Child) ExitCode() *int                           { return c.exitCode }
func (c *Child) SignalCode() string                       { return c.signalCode }
func (c *Child) Killed() bool                             { return c.killed }
func (c *Child) OnStdout(f func(string))                  { c.onStdout = append(c.onStdout, f) }
func (c *Child) OnStderr(f func(string))                  { c.onStderr = append(c.onStderr, f) }
func (c *Child) OnClose(f func(code *int, signal string)) { c.onClose = append(c.onClose, f) }
func (c *Child) OnExit(f func(code *int, signal string))  { c.onExit = append(c.onExit, f) }
func (c *Child) OnError(f func(error))                    { c.onError = append(c.onError, f) }

// Spawn 持锁调用；事件在之后的宏任务里到来（与 Node 一样，spawn 同步返回后才可能收到事件）。
func Spawn(file string, args []string, o Options) *Child {
	c := &Child{}
	env := o.Env
	if env == nil {
		env = os.Environ()
	}
	path, lerr := lookPath(file, o.Cwd, env)
	fail := func(errno int, code string) *Child {
		c.Stdin = &Stdin{c: c, writable: !o.IgnoreStdin, queue: make(chan []byte, 1024)}
		go func() {
			for range c.Stdin.queue {
			}
		}()
		e := &SpawnError{Code: code, Errno: errno, Syscall: "spawn", Path: file}
		jsrt.Go(func() {
			v := errno
			c.exitCode = &v
			jsrt.Dispatch(func() {
				for _, f := range c.onError {
					f(e)
				}
			})
			if !o.IgnoreStdin && c.Stdin.writable {
				c.Stdin.writable = false
				close(c.Stdin.queue)
			}
			jsrt.Dispatch(func() {
				for _, f := range c.onClose {
					f(&v, "")
				}
			})
		})
		return c
	}
	if lerr != nil {
		return fail(errnoOf(lerr), codeOf(lerr))
	}
	if o.Cwd != "" {
		if st, err := os.Stat(o.Cwd); err != nil || !st.IsDir() {
			return fail(errnoOf(errENOENT), "ENOENT")
		}
	}
	cmd := exec.Command(path, args...)
	cmd.Args = append([]string{file}, args...)
	cmd.Dir = o.Cwd
	cmd.Env = env
	setSysProcAttr(cmd, file, path, args, o)
	var stdinW io.WriteCloser
	var stdoutR, stderrR io.ReadCloser
	var err error
	if !o.IgnoreStdin {
		if stdinW, err = cmd.StdinPipe(); err != nil {
			return fail(errnoOf(err), codeOf(err))
		}
	}
	if !o.IgnoreStdout {
		if stdoutR, err = cmd.StdoutPipe(); err != nil {
			return fail(errnoOf(err), codeOf(err))
		}
	}
	if !o.IgnoreStderr {
		if stderrR, err = cmd.StderrPipe(); err != nil {
			return fail(errnoOf(err), codeOf(err))
		}
	}
	if err := cmd.Start(); err != nil {
		return fail(errnoOf(err), codeOf(err))
	}
	c.cmd = cmd
	c.Pid = cmd.Process.Pid
	c.Stdin = &Stdin{c: c, w: stdinW, writable: stdinW != nil, queue: make(chan []byte, 4096)}
	if stdinW != nil {
		go func() {
			broken := false
			for b := range c.Stdin.queue {
				if broken {
					continue
				}
				if _, err := stdinW.Write(b); err != nil {
					broken = true // EPIPE：spawn.ts 吞掉 stdin 的 error
				}
			}
			_ = stdinW.Close()
		}()
	}
	var wg sync.WaitGroup
	pump := func(r io.Reader, cbs func() []func(string)) {
		defer wg.Done()
		buf := make([]byte, 65536)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				chunk := DecodeChunk(buf[:n])
				jsrt.Run(func() {
					jsrt.Dispatch(func() {
						for _, f := range cbs() {
							f(chunk)
						}
					})
				})
			}
			if err != nil {
				return
			}
		}
	}
	if stdoutR != nil {
		wg.Add(1)
		go pump(stdoutR, func() []func(string) { return c.onStdout })
	}
	if stderrR != nil {
		wg.Add(1)
		go pump(stderrR, func() []func(string) { return c.onStderr })
	}
	go func() {
		wg.Wait()
		werr := cmd.Wait()
		jsrt.Run(func() {
			code, sig := exitStatus(cmd, werr, c.termSignal)
			c.exitCode = code
			c.signalCode = sig
			if c.Stdin.writable {
				c.Stdin.writable = false
				close(c.Stdin.queue)
			}
			jsrt.Dispatch(func() {
				for _, f := range c.onExit {
					f(code, sig)
				}
			})
			jsrt.Dispatch(func() {
				for _, f := range c.onClose {
					f(code, sig)
				}
			})
		})
	}()
	return c
}

// Kill = child.kill(signal)（默认 SIGTERM）；返回是否送达，送达则 killed = true。
func (c *Child) Kill(signal string) bool {
	if signal == "" {
		signal = "SIGTERM"
	}
	if c.cmd == nil || c.cmd.Process == nil || c.exitCode != nil {
		return false
	}
	if err := killProcess(c.cmd.Process, signal); err != nil {
		return false
	}
	c.killed = true
	c.termSignal = signal
	return true
}

// Decoder 保留占位（Node 每块独立 toString，不跨块拼接多字节字符）。
type Decoder struct{}

// DecodeChunk = Buffer.toString('utf8')：WHATWG UTF-8 解码，非法序列按“最大子部分”换成 U+FFFD。
func DecodeChunk(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	i := 0
	for i < len(b) {
		c := b[i]
		if c < 0x80 {
			sb.WriteByte(c)
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xBF)
		switch {
		case c >= 0xC2 && c <= 0xDF:
			need = 1
		case c == 0xE0:
			need, lo = 2, 0xA0
		case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
			need = 2
		case c == 0xED:
			need, hi = 2, 0x9F
		case c == 0xF0:
			need, lo = 3, 0x90
		case c >= 0xF1 && c <= 0xF3:
			need = 3
		case c == 0xF4:
			need, hi = 3, 0x8F
		default:
			sb.WriteRune(utf8.RuneError)
			i++
			continue
		}
		j := i + 1
		ok := true
		for k := 0; k < need; k++ {
			if j >= len(b) {
				ok = false
				break
			}
			x := b[j]
			l, h := byte(0x80), byte(0xBF)
			if k == 0 {
				l, h = lo, hi
			}
			if x < l || x > h {
				ok = false
				break
			}
			j++
		}
		if ok {
			sb.Write(b[i:j])
		} else {
			sb.WriteRune(utf8.RuneError)
		}
		i = j
	}
	return sb.String()
}

var errENOENT = errors.New("ENOENT")

func envGet(env []string, key string, fold bool) (string, bool) {
	for i := len(env) - 1; i >= 0; i-- {
		kv := env[i]
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if k == key || (fold && strings.EqualFold(k, key)) {
			return v, true
		}
	}
	return "", false
}
