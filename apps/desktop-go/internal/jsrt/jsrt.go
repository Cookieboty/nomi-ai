// Package jsrt 为逐行移植的 Node 代码提供 JS 单线程语义：
// 全局锁（GIL）= 事件循环。持锁的代码相当于一段同步 JS；Await 释放锁等待（= await 让出），
// 子进程回调、定时器从各自 goroutine 进来时先拿锁（= 宏任务）。这样移植后的代码只在 Node 原本
// 让出的位置交错，状态机不需要额外加锁。
package jsrt

import (
	"sync"
	"time"
)

var gil sync.Mutex

// Enter 拿锁进入 JS 世界（外部 goroutine：IPC handler、子进程读流、定时器）。
func Enter() { gil.Lock() }

// Leave 离开 JS 世界。
func Leave() { gil.Unlock() }

// Run 在 JS 世界里执行 fn（宏任务）。
func Run(fn func()) {
	gil.Lock()
	defer gil.Unlock()
	fn()
}

// Call 在 JS 世界里执行 fn 并取回结果。
func Call[T any](fn func() T) T {
	gil.Lock()
	defer gil.Unlock()
	return fn()
}

// Go 起一个新的“异步函数”（void promise）：在新 goroutine 里持锁运行。
func Go(fn func()) { go Run(fn) }

/* ------------------------------- Promise ------------------------------- */

// Promise 对应 JS Promise（只结算一次）。
type Promise[T any] struct {
	once sync.Once
	done chan struct{}
	v    T
	err  error
}

func NewPromise[T any]() *Promise[T] { return &Promise[T]{done: make(chan struct{})} }

// Resolved / Rejected 是已结算的 promise。
func Resolved[T any](v T) *Promise[T] {
	p := NewPromise[T]()
	p.Resolve(v)
	return p
}

func Rejected[T any](err error) *Promise[T] {
	p := NewPromise[T]()
	p.Reject(err)
	return p
}

// Async 把一段可能 Await 的代码当作 async 函数启动：当前调用者持锁时，
// 同步部分在调用者里立即开始（与 JS 一样执行到第一个 await），之后在独立 goroutine 继续。
// 为简单起见：fn 在新 goroutine 里持锁运行；调用者继续持锁执行直到自己让出。
func Async[T any](fn func() (T, error)) *Promise[T] {
	p := NewPromise[T]()
	go func() {
		gil.Lock()
		defer gil.Unlock()
		v, err := fn()
		if err != nil {
			p.Reject(err)
		} else {
			p.Resolve(v)
		}
	}()
	return p
}

func (p *Promise[T]) Resolve(v T) {
	p.once.Do(func() { p.v = v; close(p.done) })
}

func (p *Promise[T]) Reject(err error) {
	p.once.Do(func() { p.err = err; close(p.done) })
}

// Settled 是否已结算（不阻塞）。
func (p *Promise[T]) Settled() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

// Done 结算信号。
func (p *Promise[T]) Done() <-chan struct{} { return p.done }

// Result 已结算时的值（未结算返回零值）。
func (p *Promise[T]) Result() (T, error) { return p.v, p.err }

// Await 必须在持锁时调用：释放锁等待结算，再拿回锁（= await）。
func Await[T any](p *Promise[T]) (T, error) {
	select {
	case <-p.done:
	default:
		gil.Unlock()
		<-p.done
		gil.Lock()
	}
	return p.v, p.err
}

// Block 不持锁的外部 goroutine 等待结算。
func Block[T any](p *Promise[T]) (T, error) {
	<-p.done
	return p.v, p.err
}

// Sleep = await new Promise(r => setTimeout(r, ms))。
func Sleep(d time.Duration) {
	gil.Unlock()
	time.Sleep(d)
	gil.Lock()
}

/* -------------------------------- Timers ------------------------------- */

// Timer = setTimeout 句柄；回调持锁执行，clearTimeout 之后（即使已到期在排队）不会再执行。
type Timer struct {
	t       *time.Timer
	cleared bool
}

// SetTimeout 持锁调用。
func SetTimeout(d time.Duration, fn func()) *Timer {
	if d < 0 {
		d = 0
	}
	tm := &Timer{}
	tm.t = time.AfterFunc(d, func() {
		gil.Lock()
		defer gil.Unlock()
		if tm.cleared {
			return
		}
		tm.cleared = true
		fn()
	})
	return tm
}

// ClearTimeout 持锁调用；nil 安全。
func ClearTimeout(t *Timer) {
	if t == nil {
		return
	}
	t.cleared = true
	t.t.Stop()
}

// SetInterval 持锁调用。
func SetInterval(d time.Duration, fn func()) *Timer {
	tm := &Timer{}
	var arm func()
	arm = func() {
		tm.t = time.AfterFunc(d, func() {
			gil.Lock()
			defer gil.Unlock()
			if tm.cleared {
				return
			}
			fn()
			if !tm.cleared {
				arm()
			}
		})
	}
	arm()
	return tm
}

/* ------------------------------ AbortSignal ----------------------------- */

// AbortSignal 对应 JS AbortSignal（持锁使用）。
type AbortSignal struct {
	aborted   bool
	listeners []*func()
}

// AbortController 对应 JS AbortController。
type AbortController struct{ Signal *AbortSignal }

func NewAbortController() *AbortController { return &AbortController{Signal: &AbortSignal{}} }

func (c *AbortController) Abort() {
	s := c.Signal
	if s.aborted {
		return
	}
	s.aborted = true
	ls := s.listeners
	s.listeners = nil
	for _, f := range ls {
		if f != nil && *f != nil {
			(*f)()
		}
	}
}

func (s *AbortSignal) Aborted() bool { return s != nil && s.aborted }

// OnAbort = addEventListener('abort', fn, {once:true})；返回 removeEventListener。
func (s *AbortSignal) OnAbort(fn func()) func() {
	if s == nil {
		return func() {}
	}
	f := &fn
	s.listeners = append(s.listeners, f)
	return func() {
		for i, x := range s.listeners {
			if x == f {
				s.listeners = append(s.listeners[:i:i], s.listeners[i+1:]...)
				return
			}
		}
	}
}

// JSThrow 表示 Node 侧同一输入会抛出的 JS 异常。被移植代码以 panic(JSThrow) 复现「抛出」。
type JSThrow struct{ Name, Message string }

func (e JSThrow) Error() string { return e.Message }

// Uncaught = process.on('uncaughtException')（宿主注入；host-electron：记录日志，生产环境 app.quit()）。
var Uncaught = func(err error) {}

// Dispatch 按 EventEmitter.emit 语义调用监听者：某个监听者抛出 JSThrow 时，
// 后续监听者不再收到本次事件，异常交给 Uncaught（事件源在宏任务里 emit，无人捕获）。
func Dispatch(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(JSThrow)
			if !ok {
				panic(r)
			}
			Uncaught(e)
		}
	}()
	fn()
}
