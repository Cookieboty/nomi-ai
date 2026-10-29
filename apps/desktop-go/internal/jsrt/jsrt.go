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

// Leave 离开 JS 世界（让出）。处在某个 Async 的同步阶段时，锁直接交还给调用者（= async 函数在首个
// await 处把控制权还给调用方）。
func Leave() { release() }

// frames：正在同步阶段执行的 Async 调用栈（只在持锁时访问）。
var frames []chan struct{}

func release() {
	if n := len(frames); n > 0 {
		f := frames[n-1]
		frames = frames[:n-1]
		close(f)
		return
	}
	gil.Unlock()
}

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

// Go = setImmediate(fn)：排一个宏任务（不在当前同步段内执行）。
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

// Async = 调用一个 async 函数（必须持锁调用）：fn 立即在新 goroutine 里执行同步部分（锁移交），
// 到第一个让出点（Await/Sleep/Leave）或结束时把锁还给调用者，调用者继续——与 JS 一致。
func Async[T any](fn func() (T, error)) *Promise[T] {
	p := NewPromise[T]()
	ch := make(chan struct{})
	frames = append(frames, ch)
	go func() {
		var v T
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					if e, ok := r.(JSThrow); ok {
						err = e // async 函数里的 throw = 拒绝
						return
					}
					panic(r)
				}
			}()
			v, err = fn()
		}()
		if err != nil {
			p.Reject(err)
		} else {
			p.Resolve(v)
		}
		if n := len(frames); n > 0 && frames[n-1] == ch {
			frames = frames[:n-1]
			close(ch)
		} else {
			gil.Unlock()
		}
	}()
	<-ch
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
	if len(frames) == 0 && p.Settled() {
		return p.v, p.err
	}
	release()
	<-p.done
	gil.Lock()
	return p.v, p.err
}

// Block 不持锁的外部 goroutine 等待结算。
func Block[T any](p *Promise[T]) (T, error) {
	<-p.done
	return p.v, p.err
}

// Sleep = await new Promise(r => setTimeout(r, ms))。
func Sleep(d time.Duration) {
	release()
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

// UndefinedT / Undefined：需要区分 JS undefined 与 null 时使用（Go nil = null）。
type UndefinedT struct{}

var Undefined = UndefinedT{}
