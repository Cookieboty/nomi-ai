package gwstore

import (
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/server"
)

// syncChild：收到首个 config 时在 PostMessage 里同步回 onConfig（模拟网关 goroutine 恰好在
// WhenReady 读完状态之后、注册 waiter 之前进入终态）
type syncChild struct {
	mu       sync.Mutex
	msg      func(server.WorkerOutbound)
	onConfig func(c *syncChild)
	fired    bool
}

func (c *syncChild) PostMessage(m server.WorkerInbound) {
	c.mu.Lock()
	fire := m.Type == "config" && !c.fired && c.onConfig != nil
	c.fired = c.fired || fire
	c.mu.Unlock()
	if fire {
		c.onConfig(c)
	}
}
func (c *syncChild) OnMessage(fn func(m server.WorkerOutbound)) { c.msg = fn }
func (c *syncChild) OnExit(func(code int))                      {}
func (c *syncChild) Kill() bool                                 { return true }

func newSyncProcess(onConfig func(c *syncChild)) *GatewayProcess {
	gp := NewGatewayProcess(ProcessDeps{
		Lazy: true,
		Fork: func() GatewayChild { return &syncChild{onConfig: onConfig} },
	})
	gp.Apply(gwConfigForTest())
	return gp
}

// whenReadyFast：WhenReady 应立即返回；超时（丢失唤醒）则测试失败
func whenReadyFast(t *testing.T, gp *GatewayProcess) bool {
	t.Helper()
	start := time.Now()
	ok := gp.WhenReady(2 * time.Second)
	if d := time.Since(start); d > time.Second {
		t.Fatalf("WhenReady waited %v (lost wakeup)", d)
	}
	return ok
}

// #196：listening 落在首次读状态与注册 waiter 之间，应立即成功而不是等满超时
func TestWhenReadyListeningBeforeRegister(t *testing.T) {
	gp := newSyncProcess(func(c *syncChild) {
		c.msg(server.WorkerOutbound{Type: "listening", Port: 18999, URL: "http://127.0.0.1:18999"})
	})
	defer gp.Stop()
	if !whenReadyFast(t, gp) {
		t.Fatal("WhenReady = false, want true")
	}
	if n := waiterCount(gp); n != 0 {
		t.Fatalf("leftover waiters = %d", n)
	}
}

// 同一窗口里进入 failed：立即失败
func TestWhenReadyFatalBeforeRegister(t *testing.T) {
	gp := newSyncProcess(func(c *syncChild) {
		c.msg(server.WorkerOutbound{Type: "error", Message: "EADDRINUSE", Fatal: true})
	})
	defer gp.Stop()
	if whenReadyFast(t, gp) {
		t.Fatal("WhenReady = true, want false")
	}
	if n := waiterCount(gp); n != 0 {
		t.Fatalf("leftover waiters = %d", n)
	}
}

// 多个并发 waiter、超时清理与 Stop 都不遗留 waiter
func TestWhenReadyConcurrentWaitersAndCleanup(t *testing.T) {
	var child *syncChild
	gp := NewGatewayProcess(ProcessDeps{
		Lazy: true,
		Fork: func() GatewayChild { child = &syncChild{}; return child },
	})
	gp.Apply(gwConfigForTest())

	// 超时：返回 false 并移除自己
	if gp.WhenReady(20 * time.Millisecond) {
		t.Fatal("WhenReady before listening = true")
	}
	if n := waiterCount(gp); n != 0 {
		t.Fatalf("waiters after timeout = %d", n)
	}

	const n = 8
	res := make(chan bool, n)
	for range n {
		go func() { res <- gp.WhenReady(5 * time.Second) }()
	}
	deadline := time.Now().Add(2 * time.Second)
	for waiterCount(gp) < n && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	child.msg(server.WorkerOutbound{Type: "listening", Port: 18999, URL: "http://127.0.0.1:18999"})
	for range n {
		if !<-res {
			t.Fatal("concurrent waiter got false")
		}
	}
	// 已在运行：立即成功
	if !whenReadyFast(t, gp) {
		t.Fatal("WhenReady while running = false")
	}

	// Stop：已注册的 waiter 立即失败，之后的调用也立即失败
	gp2 := NewGatewayProcess(ProcessDeps{Lazy: true, Fork: func() GatewayChild { return &syncChild{} }})
	gp2.Apply(gwConfigForTest())
	done := make(chan bool, 1)
	go func() { done <- gp2.WhenReady(5 * time.Second) }()
	for waiterCount(gp2) < 1 {
		time.Sleep(time.Millisecond)
	}
	gp2.Stop()
	if <-done {
		t.Fatal("waiter after Stop = true")
	}
	if whenReadyFast(t, gp2) {
		t.Fatal("WhenReady after Stop = true")
	}
	if n := waiterCount(gp2); n != 0 {
		t.Fatalf("waiters after Stop = %d", n)
	}
	gp.Stop()
}

func waiterCount(gp *GatewayProcess) int {
	gp.mu.Lock()
	defer gp.mu.Unlock()
	return len(gp.readyWaiters)
}
