package mcp

import (
	"bytes"
	"io"
	"os"
	"regexp"
	"runtime"
	"sync"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/nodeproc"
)

// StdioConfig（mcp-stdio-transport.ts）
type StdioConfig struct {
	Command string
	Args    []string
	Env     [][2]string // nil = undefined
	Stderr  io.Writer   // nil = 'inherit'（经管道转写到 os.Stderr，D-B5-MCP-2）
	Cwd     string
}

// StdioTransport = StdioMCPTransport
type StdioTransport struct {
	cfg StdioConfig

	mu        sync.Mutex
	child     *nodeproc.Child // nil = this.process undefined
	aborted   bool
	readBuf   []byte
	hasBuf    bool
	onclose   func()
	onerror   func(error)
	onmessage func(Message) error

	q *eventQueue
}

func NewStdioTransport(cfg StdioConfig) *StdioTransport {
	return &StdioTransport{cfg: cfg, q: newEventQueue()}
}

func (t *StdioTransport) SupportsDiscovery() bool   { return true }
func (t *StdioTransport) SupportsToolHeaders() bool { return false }
func (t *StdioTransport) SetProtocolVersion(string) {}
func (t *StdioTransport) SetHandlers(c func(), e func(error), m func(Message) error) {
	t.onclose, t.onerror, t.onmessage = c, e, m
}

func (t *StdioTransport) emitClose() {
	if t.onclose != nil {
		t.onclose()
	}
}
func (t *StdioTransport) emitError(err error) {
	if t.onerror != nil {
		t.onerror(err)
	}
}

var lineBreakRe = regexp.MustCompile(`[\r\n]`)

func (t *StdioTransport) Start() <-chan error {
	t.mu.Lock()
	if t.child != nil {
		t.mu.Unlock()
		return resolved(newClientError("StdioMCPTransport already started."))
	}
	t.mu.Unlock()
	done := make(chan error, 1)
	var once sync.Once
	settle := func(err error) { once.Do(func() { done <- err }) }

	isWin := runtime.GOOS == "windows"
	if isWin {
		for _, v := range append([]string{t.cfg.Command}, t.cfg.Args...) {
			if lineBreakRe.MatchString(v) {
				err := typeError("Stdio MCP commands and arguments must not contain line breaks on Windows.")
				settle(err)
				t.emitError(err)
				return done
			}
		}
	}
	env := getEnvironment(t.cfg.Env, isWin, processEnvLookup)
	envList := make([]string, len(env))
	for i, kv := range env {
		envList[i] = kv[0] + "=" + kv[1]
	}
	file, args := t.cfg.Command, t.cfg.Args
	if args == nil {
		args = []string{}
	}
	var parsed *crossParsed
	opts := nodeproc.Options{Env: envList, Cwd: t.cfg.Cwd}
	if isWin {
		cwd, _ := os.Getwd()
		pathext, _ := processEnvLookup("PATHEXT")
		comspec, _ := processEnvLookup("COMSPEC")
		p := crossSpawnParse(file, args, crossEnv{env: env, cwd: cwd, pathext: pathext, comspec: comspec, stat: os.Stat, read: os.ReadFile})
		parsed = &p
		file, args, opts.Verbatim = p.command, p.args, p.verbatim
	}

	jsrt.Run(func() {
		child := nodeproc.Spawn(file, args, opts)
		t.mu.Lock()
		t.child = child
		aborted := t.aborted
		t.mu.Unlock()
		child.OnError(func(err error) {
			t.q.push(func() {
				if IsAbortError(err) {
					t.emitClose()
					return
				}
				settle(err)
				t.emitError(err)
			})
		})
		if parsed != nil {
			child.OnExit(func(code *int, _ string) {
				if err := crossENOENT(code, *parsed); err != nil {
					t.q.push(func() { settle(err); t.emitError(err) })
				}
			})
		}
		child.OnClose(func(*int, string) {
			t.q.push(func() {
				t.mu.Lock()
				if t.child == child {
					t.child = nil
				}
				t.mu.Unlock()
				t.emitClose()
			})
		})
		child.OnStdoutBytes(func(b []byte) {
			t.q.push(func() { t.append(b) })
		})
		stderr := t.cfg.Stderr
		if stderr == nil {
			stderr = os.Stderr
		}
		child.OnStderr(func(s string) { _, _ = io.WriteString(stderr, s) })
		if child.Pid > 0 {
			t.q.push(func() { settle(nil) }) // 'spawn'
		}
		_ = aborted
	})
	return done
}

func (t *StdioTransport) append(b []byte) {
	t.mu.Lock()
	t.readBuf = append(t.readBuf, b...)
	t.hasBuf = true
	t.mu.Unlock()
	for {
		t.mu.Lock()
		i := bytes.IndexByte(t.readBuf, '\n')
		if !t.hasBuf || i < 0 {
			t.mu.Unlock()
			return
		}
		line := nodeproc.DecodeChunk(t.readBuf[:i])
		t.readBuf = t.readBuf[i+1:]
		t.mu.Unlock()
		msg, err := ParseJSONRPCMessage(line)
		if err == nil && t.onmessage != nil {
			err = t.onmessage(msg)
		}
		if err != nil {
			t.emitError(err)
		}
	}
}

// Close：abortController.abort()（spawn 的 signal：kill SIGTERM，送达则 'error' AbortError → onclose）
func (t *StdioTransport) Close(Signal) <-chan error {
	t.mu.Lock()
	child := t.child
	t.aborted = true
	t.child = nil
	t.readBuf = nil
	t.hasBuf = false
	t.mu.Unlock()
	if child != nil {
		killed := jsrt.Call(func() bool { return child.Kill("SIGTERM") })
		if killed {
			t.emitClose()
		}
	}
	return resolved(nil)
}

func (t *StdioTransport) Send(msg *u.Obj, _ *SendOptions) <-chan error {
	t.mu.Lock()
	child := t.child
	t.mu.Unlock()
	if child == nil {
		return resolved(newClientError("StdioClientTransport not connected"))
	}
	line := u.Stringify(msg) + "\n"
	jsrt.Run(func() { child.Stdin.Write(line) })
	return resolved(nil)
}

// eventQueue：按序执行回调的单 goroutine 队列（替代 Node 事件循环，避免在 jsrt 锁内调用客户端）
type eventQueue struct {
	mu   sync.Mutex
	list []func()
	cond *sync.Cond
}

func newEventQueue() *eventQueue {
	q := &eventQueue{}
	q.cond = sync.NewCond(&q.mu)
	go q.loop()
	return q
}

func (q *eventQueue) push(f func()) {
	q.mu.Lock()
	q.list = append(q.list, f)
	q.mu.Unlock()
	q.cond.Signal()
}

func (q *eventQueue) loop() {
	for {
		q.mu.Lock()
		for len(q.list) == 0 {
			q.cond.Wait()
		}
		f := q.list[0]
		q.list = q.list[1:]
		q.mu.Unlock()
		f()
	}
}
