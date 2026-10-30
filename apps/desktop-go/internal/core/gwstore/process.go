package gwstore

// process.go = core/src/gateway/GatewayProcess.ts：网关进程守护（unified-gateway §5.3）。
// 拉起网关、推送配置快照；意外退出按指数退避重启（1s、2s、4s…最长 30s）；
// 60s 内 5 次失败熔断；whenReady 最长等 10 秒；lazy 时第一次 ensureStarted/whenReady 才拉起。
// fork 可注入；默认 fork 在本进程内跑 server.RunGatewayWorker（偏差 D-B5-GW-1：Electron utilityProcess → goroutine）。

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/route"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/upstream"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// GatewayChild = GatewayChild
type GatewayChild interface {
	PostMessage(m server.WorkerInbound)
	OnMessage(fn func(m server.WorkerOutbound))
	OnExit(fn func(code int))
	Kill() bool
}

// ForkGateway = ForkGateway
type ForkGateway func() GatewayChild

// GatewayStatus = GatewayStatus
type GatewayStatus struct {
	State string // stopped | starting | running | failed
	Port  int
	URL   string
	Error string
}

// Obj：JS 形状
func (s GatewayStatus) Obj() *u.Obj {
	o := u.NewObj("state", s.State)
	switch s.State {
	case "running":
		o.Set("port", float64(s.Port)).Set("url", s.URL)
	case "failed":
		o.Set("error", s.Error)
	}
	return o
}

const (
	CrashFuseMax      = 5
	CrashFuseWindowMs = 60_000
	readyTimeoutMs    = 10_000
	stopWaitMs        = 5_000
)

// ProcessDeps = GatewayProcess 的构造参数
type ProcessDeps struct {
	Logger      Logger
	OnUsage     func(e *u.Obj)
	OnLearn     func(e server.LearnEvent)
	OnKeyStatus func(e upstream.KeyStatusEvent)
	OnStatus    func(s GatewayStatus)
	Fork        ForkGateway
	BackoffMs   func(attempt int) int
	Now         func() float64
	FuseMax     int
	FuseWindow  int
	Lazy        bool
}

// afterFunc = setTimeout（重启退避定时器；测试截获）
var afterFunc = time.AfterFunc

// GatewayProcess = GatewayProcess
type GatewayProcess struct {
	d            ProcessDeps
	mu           sync.Mutex
	child        GatewayChild
	spawning     int // >0：已标 starting、fork 尚未执行（Node 单线程里 setStatus→fork 是同步的；这里把 fork 放到 onStatus 之后）
	spawnGen     int
	config       *u.Obj
	status       GatewayStatus
	failureTimes []float64
	restartTimer *time.Timer
	stopping     bool
	readyWaiters []chan bool
	wanted       bool
	tabAck       func(m route.BindingAck)
	tabSpawn     func() error
}

func NewGatewayProcess(d ProcessDeps) *GatewayProcess {
	if d.Fork == nil {
		d.Fork = InProcessFork(server.GatewayHooks{})
	}
	return &GatewayProcess{d: d, status: GatewayStatus{State: "stopped"}, wanted: !d.Lazy}
}

func (g *GatewayProcess) GetStatus() GatewayStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.status
}

func (g *GatewayProcess) now() float64 {
	if g.d.Now != nil {
		return g.d.Now()
	}
	return float64(time.Now().UnixMilli())
}
func (g *GatewayProcess) fuseMax() int {
	if g.d.FuseMax > 0 {
		return g.d.FuseMax
	}
	return CrashFuseMax
}
func (g *GatewayProcess) fuseWindow() int {
	if g.d.FuseWindow > 0 {
		return g.d.FuseWindow
	}
	return CrashFuseWindowMs
}

func (g *GatewayProcess) noteFailure() bool {
	now := g.now()
	g.failureTimes = append(g.failureTimes, now)
	kept := g.failureTimes[:0]
	for _, t := range g.failureTimes {
		if now-t <= float64(g.fuseWindow()) {
			kept = append(kept, t)
		}
	}
	g.failureTimes = kept
	return len(g.failureTimes) >= g.fuseMax()
}

// setStatus 须持锁调用；回调在解锁后执行（返回的函数）
func (g *GatewayProcess) setStatus(s GatewayStatus) func() {
	g.status = s
	var ws []chan bool
	if s.State == "running" || s.State == "failed" || s.State == "stopped" {
		ws, g.readyWaiters = g.readyWaiters, nil
	}
	ok := s.State == "running"
	return func() {
		if g.d.OnStatus != nil {
			g.d.OnStatus(s)
		}
		for _, w := range ws {
			w <- ok
		}
	}
}

// Apply = apply(config)
func (g *GatewayProcess) Apply(cfg *u.Obj) {
	g.mu.Lock()
	g.config = cfg
	g.stopping = false
	var after func()
	if g.spawning > 0 {
		// fork 马上执行并推送最新配置（等价于 Node 中 child 已存在时的 config 消息）
	} else if g.child != nil {
		c := g.child
		after = func() { c.PostMessage(g.inbound(cfg)) }
	} else if g.wanted && g.restartTimer == nil {
		after = g.spawnLocked()
	}
	g.mu.Unlock()
	if after != nil {
		after()
	}
}

func (g *GatewayProcess) inbound(cfg *u.Obj) server.WorkerInbound {
	c, err := ToGatewayConfig(cfg)
	if err != nil && g.d.Logger != nil {
		g.d.Logger.Warn("gateway config encode failed", err.Error())
	}
	return server.WorkerInbound{Type: "config", Config: c}
}

// EnsureStarted = ensureStarted()
func (g *GatewayProcess) EnsureStarted() {
	g.mu.Lock()
	g.wanted = true
	if g.child != nil || g.spawning > 0 || g.restartTimer != nil || g.stopping || g.config == nil || g.status.State == "failed" {
		g.mu.Unlock()
		return
	}
	after := g.spawnLocked()
	g.mu.Unlock()
	after()
}

// BindTabs = bindTabs({ ack, spawn })
func (g *GatewayProcess) BindTabs(ack func(m route.BindingAck), spawn func() error) {
	g.mu.Lock()
	g.tabAck, g.tabSpawn = ack, spawn
	g.mu.Unlock()
}

// Send = send(m)：没有网关进程时 false
func (g *GatewayProcess) Send(m route.BindingMessage) bool {
	g.mu.Lock()
	c := g.child
	g.mu.Unlock()
	if c == nil {
		return false
	}
	c.PostMessage(server.WorkerInbound{Type: m.Type, Binding: &m})
	return true
}

// WhenReady = whenReady(timeoutMs)；timeout<=0 用默认 10s
func (g *GatewayProcess) WhenReady(timeout time.Duration) bool {
	if timeout <= 0 {
		timeout = readyTimeoutMs * time.Millisecond
	}
	switch g.GetStatus().State {
	case "running":
		return true
	case "failed":
		return false
	}
	g.EnsureStarted()
	g.mu.Lock()
	// 判定与注册须在同一把锁内：Node 里 listening 是异步消息，不会插在 ensureStarted 与 push(waiter) 之间；
	// 这里网关在别的 goroutine 上，可能在上面读状态之后、注册之前就已 setStatus(running) 并清空 waiter（#196）
	if g.stopping {
		g.mu.Unlock()
		return false
	}
	switch g.status.State {
	case "running":
		g.mu.Unlock()
		return true
	case "failed":
		g.mu.Unlock()
		return false
	}
	ch := make(chan bool, 1)
	g.readyWaiters = append(g.readyWaiters, ch)
	g.mu.Unlock()
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case ok := <-ch:
		return ok
	case <-t.C:
		g.mu.Lock()
		for i, w := range g.readyWaiters {
			if w == ch {
				g.readyWaiters = append(g.readyWaiters[:i], g.readyWaiters[i+1:]...)
				break
			}
		}
		g.mu.Unlock()
		return false
	}
}

func (g *GatewayProcess) spawnLocked() func() {
	if g.d.Fork == nil {
		return g.setStatus(GatewayStatus{State: "failed", Error: i18n.T("electron.common.the-gateway-process-can-t-be-started-in")})
	}
	notify := g.setStatus(GatewayStatus{State: "starting"})
	g.spawning++
	gen := g.spawnGen
	return func() {
		// Node 顺序：setStatus(starting) → fork → on(message/exit) → postMessage(config)
		notify()
		g.mu.Lock()
		g.spawning--
		if gen != g.spawnGen {
			g.mu.Unlock()
			return
		}
		child := g.d.Fork()
		g.child = child
		cfg := g.config
		spawnHook := g.tabSpawn
		g.mu.Unlock()
		child.OnMessage(func(m server.WorkerOutbound) { g.onMessage(child, m) })
		child.OnExit(func(code int) { g.onExit(child, code) })
		if cfg != nil {
			child.PostMessage(g.inbound(cfg))
		}
		if spawnHook != nil {
			go func() {
				if err := spawnHook(); err != nil && g.d.Logger != nil {
					g.d.Logger.Warn("gateway tab bindings replay failed", err.Error())
				}
			}()
		}
	}
}

func (g *GatewayProcess) onMessage(child GatewayChild, m server.WorkerOutbound) {
	g.mu.Lock()
	if child != g.child {
		g.mu.Unlock()
		return
	}
	switch m.Type {
	case "listening":
		g.failureTimes = nil
		after := g.setStatus(GatewayStatus{State: "running", Port: m.Port, URL: m.URL})
		g.mu.Unlock()
		after()
		if g.d.Logger != nil {
			g.d.Logger.Info("gateway running", m.URL)
		}
		return
	case "error":
		if !m.Fatal {
			g.mu.Unlock()
			if g.d.Logger != nil {
				g.d.Logger.Warn("gateway error", m.Message)
			}
			return
		}
		g.failureTimes = nil
		g.noteFailure()
		after := g.setStatus(GatewayStatus{State: "failed", Error: m.Message})
		c := g.child
		g.child = nil
		g.mu.Unlock()
		if g.d.Logger != nil {
			g.d.Logger.Warn("gateway error", m.Message)
		}
		after()
		if c != nil {
			c.Kill()
		}
		return
	}
	ack := g.tabAck
	g.mu.Unlock()
	switch m.Type {
	case "usage":
		if g.d.OnUsage != nil {
			g.d.OnUsage(m.Usage)
		}
	case "learn":
		if g.d.OnLearn != nil && m.Learn != nil {
			g.d.OnLearn(*m.Learn)
		}
	case "key-status":
		if g.d.OnKeyStatus != nil && m.KeyStatus != nil {
			g.d.OnKeyStatus(*m.KeyStatus)
		}
	case "binding:ok", "binding:error":
		if ack != nil && m.Ack != nil {
			ack(*m.Ack)
		}
	}
}

func (g *GatewayProcess) onExit(child GatewayChild, code int) {
	g.mu.Lock()
	if child != g.child {
		g.mu.Unlock()
		return
	}
	g.child = nil
	if g.stopping {
		after := g.setStatus(GatewayStatus{State: "stopped"})
		g.mu.Unlock()
		after()
		return
	}
	if g.status.State == "failed" {
		g.mu.Unlock()
		return
	}
	fused := g.noteFailure()
	n := len(g.failureTimes)
	if g.d.Logger != nil {
		g.d.Logger.Warn("gateway exited", u.NewObj("code", float64(code), "failures", float64(n), "windowMs", float64(g.fuseWindow())))
	}
	if fused {
		after := g.setStatus(GatewayStatus{State: "failed", Error: i18n.T(
			"electron.common.the-gateway-process-exited-abnormally-times-within-s",
			int(math.Round(float64(g.fuseWindow())/1000)), g.fuseMax(), code)})
		g.mu.Unlock()
		after()
		return
	}
	delay := int(math.Min(30_000, 1000*math.Pow(2, float64(n-1))))
	if g.d.BackoffMs != nil {
		delay = g.d.BackoffMs(n)
	}
	after := g.setStatus(GatewayStatus{State: "starting"})
	g.restartTimer = afterFunc(time.Duration(delay)*time.Millisecond, func() {
		g.mu.Lock()
		g.restartTimer = nil
		f := g.spawnLocked()
		g.mu.Unlock()
		f()
	})
	g.mu.Unlock()
	after()
}

// Retry = retry()
func (g *GatewayProcess) Retry() {
	g.mu.Lock()
	g.failureTimes = nil
	c := g.child
	g.child = nil
	g.spawnGen++
	g.wanted = true
	var after func()
	if g.config != nil {
		after = g.spawnLocked()
	}
	g.mu.Unlock()
	if c != nil {
		c.Kill()
	}
	if after != nil {
		after()
	}
}

// Stop = stop()
func (g *GatewayProcess) Stop() {
	g.mu.Lock()
	g.stopping = true
	if g.restartTimer != nil {
		g.restartTimer.Stop()
	}
	g.restartTimer = nil
	c := g.child
	g.child = nil
	g.spawnGen++
	after := g.setStatus(GatewayStatus{State: "stopped"})
	g.mu.Unlock()
	if c != nil {
		c.PostMessage(server.WorkerInbound{Type: "stop"})
		c.Kill()
		if w, ok := c.(interface{ WaitExit(time.Duration) bool }); ok && !w.WaitExit(stopWaitMs*time.Millisecond) && g.d.Logger != nil {
			g.d.Logger.Warn("gateway worker did not exit in time", nil)
		}
	}
	after()
}

/* ------------------------------ 本进程内的网关「子进程」 ------------------------------ */

type inProcChild struct {
	mu     sync.Mutex
	in     func(m server.WorkerInbound)
	out    func(m server.WorkerOutbound)
	exit   func(code int)
	done   chan struct{}
	exited chan struct{} // 网关循环结束（Stop + 落盘完成）
	exOnce sync.Once
	killed bool
	queue  []server.WorkerOutbound
}

func (c *inProcChild) OnMessage(fn func(m server.WorkerInbound)) { c.in = fn } // WorkerPort（网关一侧）
func (c *inProcChild) Done() <-chan struct{}                     { return c.done }
func (c *inProcChild) Finished()                                 { c.exOnce.Do(func() { close(c.exited) }) }
func (c *inProcChild) PostMessage(m server.WorkerOutbound) { // WorkerPort（网关一侧）
	c.mu.Lock()
	out := c.out
	if out == nil {
		c.queue = append(c.queue, m)
	}
	c.mu.Unlock()
	if out != nil {
		go out(m) // 异步投递，同 postMessage
	}
}

type parentSide struct{ c *inProcChild }

func (p parentSide) PostMessage(m server.WorkerInbound) {
	select {
	case <-p.c.done:
	default:
		if p.c.in != nil {
			p.c.in(m)
		}
	}
}
func (p parentSide) OnMessage(fn func(m server.WorkerOutbound)) {
	p.c.mu.Lock()
	p.c.out = fn
	q := p.c.queue
	p.c.queue = nil
	p.c.mu.Unlock()
	for _, m := range q {
		go fn(m)
	}
}

// WaitExit：等网关循环结束（Node 的子进程在 stop 后自行退出、落盘不占父进程；进程内实现须等它，
// 否则 Dispose 返回后 goroutine 仍在写用户数据目录）
func (p parentSide) WaitExit(timeout time.Duration) bool {
	select {
	case <-p.c.exited:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (p parentSide) OnExit(fn func(code int)) { p.c.exit = fn }
func (p parentSide) Kill() bool {
	p.c.mu.Lock()
	if p.c.killed {
		p.c.mu.Unlock()
		return false
	}
	p.c.killed = true
	close(p.c.done)
	exit := p.c.exit
	p.c.mu.Unlock()
	if exit != nil {
		go exit(0)
	}
	return true
}

// InProcessFork：在本进程内跑网关消息循环（worker.ts 的 runGatewayWorker）。
// 网关循环 panic 时按进程异常退出（code 1）上报，走同样的退避 / 熔断。
func InProcessFork(hooks server.GatewayHooks) ForkGateway {
	return func() GatewayChild {
		c := &inProcChild{done: make(chan struct{}), exited: make(chan struct{})}
		p := parentSide{c}
		func() {
			defer func() {
				if r := recover(); r != nil {
					c.Finished()
					go func() {
						if c.exit != nil {
							c.exit(1)
						}
					}()
					_ = fmt.Sprint(r)
				}
			}()
			server.RunGatewayWorker(c, hooks)
		}()
		return p
	}
}
