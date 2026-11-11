package computer

import (
	"context"
	"sort"
	"sync"
	"time"
)

// 谁在操作桌面（Nomi / 某个编程助手）与紧急停止。
// 正在执行或 activeFor 内动过的算「在操作」：灵动岛与对话窗口上显示「正在操作桌面 · 停止」。
// 停止：取消所有正在执行的 agent-desktop 命令，stopHold 内的新调用直接返回 stopped（让模型停下等用户）。

const (
	activeFor = 20 * time.Second
	stopHold  = 10 * time.Second
	// ActorNomi：Nomi 自己的对话 / 任务
	ActorNomi = "Nomi"
)

type actorKey struct{}

// WithActor：这次调用是谁发起的（编程助手名；没有 = Nomi）
func WithActor(ctx context.Context, actor string) context.Context {
	if actor == "" {
		return ctx
	}
	return context.WithValue(ctx, actorKey{}, actor)
}

// ActorOf：发起方（没有 = Nomi）
func ActorOf(ctx context.Context) string {
	if ctx != nil {
		if a, _ := ctx.Value(actorKey{}).(string); a != "" {
			return a
		}
	}
	return ActorNomi
}

type activity struct {
	mu        sync.Mutex
	seq       int64
	running   map[int64]runningCall
	last      map[string]time.Time
	stopUntil time.Time
	listeners []func()
	timer     *time.Timer
	// stateListeners：OnStateChange
	stateListeners []func()
}

type runningCall struct {
	actor  string
	cancel context.CancelFunc
}

func newActivity() *activity {
	return &activity{running: map[int64]runningCall{}, last: map[string]time.Time{}}
}

// OnActivity：「谁在操作」变化时回调（灵动岛、对话窗口）
func (s *Service) OnActivity(fn func()) {
	s.act.mu.Lock()
	s.act.listeners = append(s.act.listeners, fn)
	s.act.mu.Unlock()
}

func (a *activity) notify() {
	a.mu.Lock()
	ls := append([]func(){}, a.listeners...)
	a.mu.Unlock()
	for _, fn := range ls {
		fn()
	}
}

// begin：开始一条命令；返回结束函数。停止期内返回 stopped
func (s *Service) begin(ctx context.Context, cancel context.CancelFunc) (func(), error) {
	a := s.act
	actor := ActorOf(ctx)
	a.mu.Lock()
	if time.Now().Before(a.stopUntil) {
		a.mu.Unlock()
		return nil, errStopped()
	}
	a.seq++
	id := a.seq
	_, was := a.last[actor]
	a.running[id] = runningCall{actor: actor, cancel: cancel}
	a.last[actor] = time.Now()
	a.mu.Unlock()
	if !was {
		a.notify()
	}
	return func() {
		a.mu.Lock()
		delete(a.running, id)
		if _, ok := a.last[actor]; ok {
			a.last[actor] = time.Now()
		}
		// activeFor 之后再看一次：没人动了就收起「正在操作」
		if a.timer != nil {
			a.timer.Stop()
		}
		a.timer = time.AfterFunc(activeFor+time.Second, func() {
			if s.expire() {
				a.notify()
			}
		})
		a.mu.Unlock()
	}, nil
}

// expire：去掉 activeFor 内没动过的；有变化返回 true
func (s *Service) expire() bool {
	a := s.act
	a.mu.Lock()
	defer a.mu.Unlock()
	busy := map[string]bool{}
	for _, r := range a.running {
		busy[r.actor] = true
	}
	changed := false
	for actor, t := range a.last {
		if !busy[actor] && time.Since(t) > activeFor {
			delete(a.last, actor)
			changed = true
		}
	}
	return changed
}

// Active：正在操作桌面的发起方（排好序）
func (s *Service) Active() []string {
	s.expire()
	a := s.act
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, 0, len(a.last))
	for actor := range a.last {
		out = append(out, actor)
	}
	sort.Strings(out)
	return out
}

// StopAll：紧急停止：取消正在执行的命令，stopHold 内拒绝新的调用
func (s *Service) StopAll() {
	a := s.act
	a.mu.Lock()
	a.stopUntil = time.Now().Add(stopHold)
	for _, r := range a.running {
		r.cancel()
	}
	a.running = map[int64]runningCall{}
	a.last = map[string]time.Time{}
	a.mu.Unlock()
	a.notify()
}

// Stopped：是不是刚按过紧急停止
func (s *Service) Stopped() bool {
	s.act.mu.Lock()
	defer s.act.mu.Unlock()
	return time.Now().Before(s.act.stopUntil)
}

func errStopped() *Error {
	return errf("stopped", "用户按了紧急停止：不要再操作桌面，停下来等用户的新指示")
}

// OnStateChange：设置页要重新读状态时回调（后台查到了新版本等）
func (s *Service) OnStateChange(fn func()) {
	s.act.mu.Lock()
	s.act.stateListeners = append(s.act.stateListeners, fn)
	s.act.mu.Unlock()
}

func (s *Service) stateChanged() {
	s.act.mu.Lock()
	ls := append([]func(){}, s.act.stateListeners...)
	s.act.mu.Unlock()
	for _, fn := range ls {
		fn()
	}
}
