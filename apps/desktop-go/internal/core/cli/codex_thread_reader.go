package cli

// codex_thread_reader.go mirrors packages/core/src/cli/codexThreadReader.ts + codexThreadWorker.ts。
// Node 把同步的 node:sqlite 整表 SELECT 放到 worker_threads，只为不阻塞主进程事件循环；
// Go 的"worker"是一个 goroutine（D-B7-S-2）：读库在 jsrt 锁外执行，回复经 jsrt.Run 派发（等价 'message' 事件）。
// 状态机（懒启动、复用、空闲回收、超时/崩溃失败所有请求、连续崩溃回退主线程读取）逐行同 Node。

import (
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// CodexIndexRequest = 主线程 → worker。
type CodexIndexRequest struct {
	ID   int
	File string
}

// CodexIndexReply = worker → 主线程（Ok=false 时 Message 为错误信息）。
type CodexIndexReply struct {
	ID      int
	Ok      bool
	Rows    []*util.Obj
	Message string
}

// CodexIndexWorkerLike = worker_threads.Worker 中用到的部分（测试可注入假 worker）。
// 回调均在 jsrt 锁内调用；PostMessage 返回 error 等价 Node 同步抛错。
type CodexIndexWorkerLike interface {
	PostMessage(m CodexIndexRequest) error
	OnMessage(fn func(CodexIndexReply))
	OnError(fn func(error))
	OnExit(fn func(code int))
	Terminate()
	Ref()
	Unref()
}

// CodexThreadReaderOptions mirrors CodexThreadReaderOptions（nil 指针 = undefined）。
type CodexThreadReaderOptions struct {
	// Spawn 返回 (nil, nil) 或 error 表示不可用，直接主线程读取；Spawn 本身为 nil 同 Node 的 null。
	Spawn      func() (CodexIndexWorkerLike, error)
	Local      func(file string) ([]*util.Obj, error)
	TimeoutMs  *int
	IdleMs     *int
	MaxCrashes *int
	// Warn = log.warn（默认写标准日志）。
	Warn func(msg string, args ...any)
}

type crPending struct {
	p     *jsrt.Promise[[]*util.Obj]
	timer *jsrt.Timer
}

// CodexThreadReader mirrors class CodexThreadReader。所有方法持 jsrt 锁调用。
type CodexThreadReader struct {
	opts       CodexThreadReaderOptions
	w          CodexIndexWorkerLike
	seq        int
	pending    map[int]*crPending
	order      []int // Map 插入序（failAll 按序 reject）
	crashes    int
	inProc     bool
	idle       *jsrt.Timer
	timeoutMs  int
	idleMs     int
	maxCrashes int
}

func NewCodexThreadReader(opts CodexThreadReaderOptions) *CodexThreadReader {
	r := &CodexThreadReader{opts: opts, pending: map[int]*crPending{}, timeoutMs: 10_000, idleMs: 60_000, maxCrashes: 3}
	if opts.TimeoutMs != nil {
		r.timeoutMs = *opts.TimeoutMs
	}
	if opts.IdleMs != nil {
		r.idleMs = *opts.IdleMs
	}
	if opts.MaxCrashes != nil {
		r.maxCrashes = *opts.MaxCrashes
	}
	return r
}

func (r *CodexThreadReader) warn(msg string, args ...any) {
	if r.opts.Warn != nil {
		r.opts.Warn(msg, args...)
		return
	}
	log.Println(append([]any{"[codex-index]", msg}, args...)...)
}

// InProcess = get inProcess。
func (r *CodexThreadReader) InProcess() bool { return r.inProc }

// Running = get running。
func (r *CodexThreadReader) Running() bool { return r.w != nil }

func (r *CodexThreadReader) Read(file string) *jsrt.Promise[[]*util.Obj] {
	r.cancelIdle()
	var w CodexIndexWorkerLike
	if !r.inProc {
		w = r.worker()
	}
	if w == nil {
		r.inProc = true
		local := r.opts.Local
		if local == nil {
			local = func(f string) ([]*util.Obj, error) { return ReadCodexThreads(f), nil }
		}
		rows, err := local(file)
		if err != nil {
			return jsrt.Rejected[[]*util.Obj](err)
		}
		return jsrt.Resolved(rows)
	}
	r.seq++
	id := r.seq
	p := jsrt.NewPromise[[]*util.Obj]()
	timer := jsrt.SetTimeout(time.Duration(r.timeoutMs)*time.Millisecond, func() {
		r.crash(w, errors.New("Codex index query timed out"), false)
	})
	r.pending[id] = &crPending{p: p, timer: timer}
	r.order = append(r.order, id)
	if len(r.pending) == 1 {
		w.Ref()
	}
	if err := w.PostMessage(CodexIndexRequest{ID: id, File: file}); err != nil {
		r.settle(id, err, nil)
	}
	return p
}

// Shutdown = shutdown()：立即结束 worker（进行中的请求失败）。
func (r *CodexThreadReader) Shutdown() {
	r.cancelIdle()
	w := r.w
	r.w = nil
	r.failAll(errors.New("Codex index reader closed"))
	if w != nil {
		w.Terminate()
	}
}

func (r *CodexThreadReader) worker() CodexIndexWorkerLike {
	if r.w != nil {
		return r.w
	}
	if r.opts.Spawn == nil {
		return nil
	}
	w, err := r.opts.Spawn()
	if err != nil {
		r.warn("Codex 索引 worker 无法启动，改用主进程内读取", err)
		return nil
	}
	if w == nil {
		return nil
	}
	w.Unref()
	w.OnMessage(func(m CodexIndexReply) {
		if r.w != w {
			return
		}
		r.crashes = 0
		if m.Ok {
			r.settle(m.ID, nil, m.Rows)
		} else {
			r.settle(m.ID, errors.New(m.Message), nil)
		}
	})
	w.OnError(func(e error) { r.crash(w, e, true) })
	w.OnExit(func(code int) { r.crash(w, fmt.Errorf("Codex index worker exited (%d)", code), true) })
	r.w = w
	return w
}

func (r *CodexThreadReader) crash(w CodexIndexWorkerLike, e error, count bool) {
	if r.w != w {
		return
	}
	r.w = nil
	r.cancelIdle()
	if count {
		r.crashes++
	}
	r.warn("Codex 索引 worker 异常", e.Error())
	r.failAll(e)
	w.Terminate()
	if r.crashes >= r.maxCrashes {
		r.warn(fmt.Sprintf("Codex 索引 worker 连续 %d 次异常，改用主进程内读取", r.crashes))
		r.inProc = true
	}
}

func (r *CodexThreadReader) del(id int) {
	delete(r.pending, id)
	for i, x := range r.order {
		if x == id {
			r.order = append(r.order[:i:i], r.order[i+1:]...)
			break
		}
	}
}

func (r *CodexThreadReader) settle(id int, err error, rows []*util.Obj) {
	p, ok := r.pending[id]
	if !ok {
		return
	}
	r.del(id)
	jsrt.ClearTimeout(p.timer)
	if len(r.pending) == 0 && r.w != nil {
		r.w.Unref()
	}
	if err != nil {
		p.p.Reject(err)
	} else {
		if rows == nil {
			rows = []*util.Obj{}
		}
		p.p.Resolve(rows)
	}
	r.maybeIdle()
}

func (r *CodexThreadReader) failAll(e error) {
	ids := r.order
	all := make([]*crPending, 0, len(ids))
	for _, id := range ids {
		all = append(all, r.pending[id])
	}
	r.pending = map[int]*crPending{}
	r.order = nil
	for _, p := range all {
		jsrt.ClearTimeout(p.timer)
		p.p.Reject(e)
	}
}

func (r *CodexThreadReader) cancelIdle() {
	jsrt.ClearTimeout(r.idle)
	r.idle = nil
}

func (r *CodexThreadReader) maybeIdle() {
	if r.w == nil || len(r.pending) > 0 || r.idle != nil {
		return
	}
	r.idle = jsrt.SetTimeout(time.Duration(r.idleMs)*time.Millisecond, func() {
		r.idle = nil
		if len(r.pending) > 0 {
			return
		}
		w := r.w
		r.w = nil
		if w != nil {
			w.Terminate()
		}
	})
}

/* ------------------------- 默认 worker：goroutine ------------------------- */

// goWorker = codexThreadWorker.ts：每个请求在锁外 ReadCodexThreads，回复持锁派发。
// Ref/Unref 无操作（Go 进程存活不受 goroutine 影响，D-B7-S-2）。
type goWorker struct {
	onMsg      func(CodexIndexReply)
	onErr      func(error)
	terminated bool // 持锁读写
	reqs       chan CodexIndexRequest
}

func newGoWorker() *goWorker {
	w := &goWorker{reqs: make(chan CodexIndexRequest, 64)}
	go w.loop()
	return w
}

func (w *goWorker) loop() {
	for m := range w.reqs { // 串行处理，同 worker 的单线程消息队列
		var reply CodexIndexReply
		var panicErr error
		func() {
			defer func() {
				if p := recover(); p != nil {
					panicErr = fmt.Errorf("%v", p)
				}
			}()
			reply = CodexIndexReply{ID: m.ID, Ok: true, Rows: ReadCodexThreads(m.File)}
		}()
		jsrt.Run(func() {
			if w.terminated {
				return
			}
			if panicErr != nil {
				// worker 内未捕获异常 → 'error' 事件
				if w.onErr != nil {
					w.onErr(panicErr)
				}
				return
			}
			if w.onMsg != nil {
				w.onMsg(reply)
			}
		})
	}
}

func (w *goWorker) PostMessage(m CodexIndexRequest) error {
	if w.terminated {
		return nil // 已终止 worker 的 postMessage 静默丢弃（同 Node）
	}
	w.reqs <- m
	return nil
}
func (w *goWorker) OnMessage(fn func(CodexIndexReply)) { w.onMsg = fn }
func (w *goWorker) OnError(fn func(error))             { w.onErr = fn }
func (w *goWorker) OnExit(func(int))                   {}
func (w *goWorker) Terminate() {
	if !w.terminated {
		w.terminated = true
		close(w.reqs)
	}
}
func (w *goWorker) Ref()   {}
func (w *goWorker) Unref() {}

var sharedCodexReader *CodexThreadReader

// ReadCodexThreadsAsync = readCodexThreadsAsync（共享读取器，持锁调用）。
func ReadCodexThreadsAsync(file string) *jsrt.Promise[[]*util.Obj] {
	if sharedCodexReader == nil {
		sharedCodexReader = NewCodexThreadReader(CodexThreadReaderOptions{
			Spawn: func() (CodexIndexWorkerLike, error) { return newGoWorker(), nil },
		})
	}
	return sharedCodexReader.Read(file)
}

// SetCodexThreadReader = setCodexThreadReader（测试用）。
func SetCodexThreadReader(r *CodexThreadReader) {
	if sharedCodexReader != nil {
		sharedCodexReader.Shutdown()
	}
	sharedCodexReader = r
}
