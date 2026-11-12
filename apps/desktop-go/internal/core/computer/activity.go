package computer

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
)

// 谁在操作桌面（Nomi / 某个编程助手）与紧急停止。
// 正在执行或 activeFor 内动过的算「在操作」：对话窗口上显示「正在操作桌面 · 停止」。
// 停止：取消所有正在执行的 agent-desktop 命令；activeFor 内操作过桌面的那几轮（按调用的 context 认）
// 之后再调用一律返回 stopped，直到用户发下一条消息（新的一轮是新的 context）。装配层再中止这几轮对话、
// 撤掉还在等的确认（StopReport 里的对话）。

const (
	activeFor = 20 * time.Second
	// blockedKeep：被停下的 context 记多久（那一轮早就结束了，只防内存一直涨）
	blockedKeep = time.Hour
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
	mu      sync.Mutex
	seq     int64
	running map[int64]runningCall
	last    map[string]time.Time
	// turns：activeFor 内调用过的 context（一轮对话 / 一个编程助手会话）→ 最后一次调用的时间与对话 id
	turns map[<-chan struct{}]turnInfo
	// pending：正在走 computer_* 工具（含等用户确认、还没开始执行命令）的那几轮 → 进行中的工具数与对话 id
	pending map[<-chan struct{}]pendingTurn
	// blocked：紧急停止时停下的 context → 停下的时间
	blocked   map[<-chan struct{}]time.Time
	listeners []func()
	timer     *time.Timer
	// stateListeners：OnStateChange
	stateListeners []func()
}

type runningCall struct {
	actor  string
	cancel context.CancelFunc
	// done / conv：这条命令所在的那一轮（紧急停止时无论跑了多久都要封禁这一轮）
	done <-chan struct{}
	conv string
}

type pendingTurn struct {
	n    int
	conv string
}

type turnInfo struct {
	at   time.Time
	conv string
}

func newActivity() *activity {
	return &activity{running: map[int64]runningCall{}, last: map[string]time.Time{},
		turns: map[<-chan struct{}]turnInfo{}, pending: map[<-chan struct{}]pendingTurn{},
		blocked: map[<-chan struct{}]time.Time{}}
}

// Enter：一次 computer_* 工具调用开始（确认之前就登记）：紧急停止时这一轮哪怕还停在确认卡、
// 还没执行任何命令，也会被封禁并中止。返回结束函数
func (s *Service) Enter(ctx context.Context) func() {
	done := ctx.Done()
	if done == nil {
		return func() {}
	}
	a := s.act
	a.mu.Lock()
	p := a.pending[done]
	p.n++
	if c := tools.ConversationFrom(ctx); c != "" {
		p.conv = c
	}
	a.pending[done] = p
	a.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			if p, ok := a.pending[done]; ok {
				if p.n <= 1 {
					delete(a.pending, done)
				} else {
					p.n--
					a.pending[done] = p
				}
			}
			a.mu.Unlock()
		})
	}
}

// StopReport：紧急停止停下了哪些对话（装配层中止这几轮）
type StopReport struct {
	Conversations []string
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

// begin：开始一条命令；返回结束函数。被紧急停止的那一轮返回 stopped
func (s *Service) begin(ctx context.Context, cancel context.CancelFunc) (func(), error) {
	a := s.act
	actor := ActorOf(ctx)
	done := ctx.Done()
	a.mu.Lock()
	if _, stopped := a.blocked[done]; stopped && done != nil {
		a.mu.Unlock()
		return nil, errStopped()
	}
	conv := tools.ConversationFrom(ctx)
	if done != nil {
		a.turns[done] = turnInfo{at: time.Now(), conv: conv}
	}
	a.seq++
	id := a.seq
	_, was := a.last[actor]
	a.running[id] = runningCall{actor: actor, cancel: cancel, done: done, conv: conv}
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
	runningTurns := map[<-chan struct{}]bool{}
	for _, r := range a.running {
		busy[r.actor] = true
		if r.done != nil {
			runningTurns[r.done] = true
		}
	}
	for done, t := range a.turns {
		// 还有命令在跑的那一轮不过期（computer_wait 最长 60 秒，比 activeFor 长）
		if !runningTurns[done] && time.Since(t.at) > activeFor {
			delete(a.turns, done)
		}
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

// StopAll：紧急停止：取消正在执行的命令；正在执行命令的那几轮、activeFor 内操作过桌面的那几轮，之后的调用都拒绝
func (s *Service) StopAll() StopReport {
	a := s.act
	now := time.Now()
	a.mu.Lock()
	convs := map[string]bool{}
	for done, t := range a.turns {
		if now.Sub(t.at) <= activeFor {
			a.blocked[done] = now
			if t.conv != "" {
				convs[t.conv] = true
			}
		}
	}
	// 正在走 computer_* 工具（含停在确认卡上）的那几轮
	for done, p := range a.pending {
		a.blocked[done] = now
		if p.conv != "" {
			convs[p.conv] = true
		}
	}
	// 正在执行的命令所在的那一轮：不管开始了多久都封禁
	for _, r := range a.running {
		if r.done != nil {
			a.blocked[r.done] = now
		}
		if r.conv != "" {
			convs[r.conv] = true
		}
	}
	a.turns = map[<-chan struct{}]turnInfo{}
	for done, at := range a.blocked {
		if now.Sub(at) > blockedKeep {
			delete(a.blocked, done)
		}
	}
	for _, r := range a.running {
		r.cancel()
	}
	a.running = map[int64]runningCall{}
	a.last = map[string]time.Time{}
	a.mu.Unlock()
	a.notify()
	rep := StopReport{}
	for c := range convs {
		rep.Conversations = append(rep.Conversations, c)
	}
	sort.Strings(rep.Conversations)
	return rep
}

// StoppedFor：这次调用所在的那一轮是不是被紧急停止了
func (s *Service) StoppedFor(ctx context.Context) bool {
	if ctx == nil || ctx.Done() == nil {
		return false
	}
	s.act.mu.Lock()
	defer s.act.mu.Unlock()
	_, ok := s.act.blocked[ctx.Done()]
	return ok
}

func errStopped() *Error {
	return errf("stopped", "用户按了紧急停止：这一轮不要再操作桌面，停下来等用户的新指示")
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
