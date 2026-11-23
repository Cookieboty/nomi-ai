package shellhandlers_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/convstore"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/shellhandlers"
)

type convSession struct {
	t  *testing.T
	s  *contract.Session
	ch chan contract.ServerFrame
	n  int

	once sync.Once
	seq  int64
	ipcR *ipcRouter
}

func (c *convSession) call(name, input string) contract.ServerFrame {
	c.t.Helper()
	f, ok := c.request(name, input).await(2 * time.Second)
	if !ok {
		c.t.Fatal("timeout " + name)
	}
	return f
}

// ipcRouter correlates contract.Session answers by request id, exactly like
// the transport does for the renderer: every answer carries the id of the
// request that produced it, regardless of completion order.
type ipcRouter struct {
	c       *convSession
	ch      chan contract.ServerFrame
	mu      sync.Mutex
	waiters map[string]chan contract.ServerFrame
}

type pending struct {
	c     *convSession
	id    string
	reply chan contract.ServerFrame
}

// until polls the live generation until check passes (bounded).
func (c *convSession) until(check func() bool) bool {
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return check()
}

// ipc answers are routed by request id to the requesting waiter; one
// goroutine owns the session channel so call/request never compete for it.
func (c *convSession) ipc() *ipcRouter {
	c.once.Do(func() {
		c.ipcR = &ipcRouter{c: c, waiters: map[string]chan contract.ServerFrame{}}
		go c.ipcR.pump()
	})
	return c.ipcR
}

func (r *ipcRouter) pump() {
	for f := range r.c.ch {
		if f.T != "res" && f.T != "err" && f.T != "end" {
			continue // events are not answers
		}
		r.mu.Lock()
		w := r.waiters[f.ID]
		delete(r.waiters, f.ID)
		r.mu.Unlock()
		if w != nil {
			w <- f
		}
	}
}

// request dispatches a request frame with a unique id and returns a handle
// that collects only this id's terminal frame.
func (c *convSession) request(name, input string) *pending {
	c.t.Helper()
	n := atomic.AddInt64(&c.seq, 1)
	id := fmt.Sprintf("ipc-%d", n)
	p := &pending{c: c, id: id, reply: make(chan contract.ServerFrame, 1)}
	r := c.ipc()
	r.mu.Lock()
	r.waiters[id] = p.reply
	r.mu.Unlock()
	c.s.Handle([]byte(`{"t":"req","id":"` + id + `","kind":"call","name":"` + name + `","input":` + input + `}`))
	return p
}

func (p *pending) await(timeout time.Duration) (contract.ServerFrame, bool) {
	select {
	case f := <-p.reply:
		return f, true
	case <-time.After(timeout):
		return contract.ServerFrame{}, false
	}
}

func TestConversationsHandlers(t *testing.T) {
	r := contract.NewRouter()
	shellhandlers.InstallConversations(r, convstore.New(t.TempDir()))
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	s.Handle([]byte(`{"t":"sub","event":"conversations.changed"}`))
	c := &convSession{t: t, s: s, ch: ch}

	if f := c.call("conversations.put", `{"source":"w1","meta":{"id":"c1","name":"A"}}`); f.T != "res" {
		t.Fatalf("put: %+v", f)
	}
	if f := c.call("conversations.append", `{"source":"w1","id":"c1","messages":[{"id":"m1","content":"hi"}],"preview":"hi"}`); f.T != "res" {
		t.Fatalf("append: %+v", f)
	}
	if f := c.call("conversations.append", `{"id":"gone","messages":[{"id":"m"}]}`); f.T != "err" || f.Error == nil || f.Error.Code != "CONVERSATION_NOT_FOUND" {
		t.Fatalf("append unknown: %+v", f)
	}
	if f := c.call("conversations.messages", `{"id":"../x"}`); f.T != "err" || f.Error.Code != "BAD_INPUT" {
		t.Fatalf("bad id: %+v", f)
	}
	f := c.call("conversations.messages", `{"id":"c1"}`)
	b, _ := json.Marshal(f.Output)
	if string(b) != `{"bytes":27,"messages":[{"id":"m1","content":"hi"}]}` {
		t.Fatalf("messages: %s", b)
	}
	// 指针：字符串 = 设，null = 清空，不传 = 不变
	c.call("conversations.setPointers", `{"current":"c1","lastNomi":"c1"}`)
	c.call("conversations.setPointers", `{"current":null}`)
	f = c.call("conversations.state", `null`)
	b, _ = json.Marshal(f.Output)
	var st struct {
		Current  string         `json:"current"`
		LastNomi string         `json:"lastNomi"`
		Counts   map[string]int `json:"counts"`
		Previews map[string]string
	}
	_ = json.Unmarshal(b, &st)
	if st.Current != "" || st.LastNomi != "c1" || st.Counts["c1"] != 1 || st.Previews["c1"] != "hi" {
		t.Fatalf("state: %s", b)
	}
}

func TestConversationsChangedEventCarriesSource(t *testing.T) {
	r := contract.NewRouter()
	shellhandlers.InstallConversations(r, convstore.New(t.TempDir()))
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	s.Handle([]byte(`{"t":"sub","event":"conversations.changed"}`))
	s.Handle([]byte(`{"t":"req","id":"1","kind":"call","name":"conversations.put","input":{"source":"w1","meta":{"id":"c1"}}}`))
	deadline := time.After(2 * time.Second)
	for {
		select {
		case f := <-ch:
			if f.T != "event" {
				continue
			}
			b, _ := json.Marshal(f.Data)
			if string(b) != `{"ids":["c1"],"index":true,"source":"w1"}` {
				t.Fatalf("event: %s", b)
			}
			return
		case <-deadline:
			t.Fatal("no event")
		}
	}
}

// 退出前等写完：最近没写过立刻返回；有进行中的写入时等它写完、再安静一会儿
func TestConversationWritesWaitIdle(t *testing.T) {
	r := contract.NewRouter()
	w := shellhandlers.InstallConversations(r, convstore.New(t.TempDir()))
	start := time.Now()
	if !w.WaitIdle(time.Second, 50*time.Millisecond) || time.Since(start) > 30*time.Millisecond {
		t.Fatal("idle store should not delay quit")
	}
	ch := make(chan contract.ServerFrame, 64)
	s := r.NewSession(context.Background(), contract.Caller{Surface: "chat"}, func(f contract.ServerFrame) { ch <- f })
	defer s.Close()
	c := &convSession{t: t, s: s, ch: ch}
	c.call("conversations.put", `{"meta":{"id":"c1"}}`)
	start = time.Now()
	if !w.WaitIdle(time.Second, 80*time.Millisecond) {
		t.Fatal("did not become idle")
	}
	if time.Since(start) < 40*time.Millisecond {
		t.Fatal("returned before the quiet period after a write")
	}
	// 一直在写：最多等 max
	c.call("conversations.put", `{"meta":{"id":"c2"}}`)
	if w.WaitIdle(20*time.Millisecond, time.Second) {
		t.Fatal("should time out while writes are recent")
	}
	var nilW *shellhandlers.ConversationWrites
	if !nilW.WaitIdle(time.Second, time.Second) {
		t.Fatal("nil tracker")
	}
}
