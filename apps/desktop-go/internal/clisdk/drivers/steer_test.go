package drivers

// steer（一轮进行中插入用户消息）：stream-json / app-server / acp 三种驱动的 steer 用例。
// 用内存里的假子进程：stdin 收到的每一行在微任务里交给 onLine，send() 往 stdout 推一行。

import (
	"strings"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

type fakeStdin struct {
	c        *fakeChild
	writable bool
}

func (s *fakeStdin) Writable() bool { return s.writable }
func (s *fakeStdin) End()           { s.writable = false }
func (s *fakeStdin) Write(chunk string) bool {
	for _, raw := range strings.Split(chunk, "\n") {
		if raw == "" {
			continue
		}
		s.c.written = append(s.c.written, raw)
		msg := O()
		if v, err := util.ParseString(raw); err == nil {
			if o, ok := v.(*util.Obj); ok {
				msg = o
			}
		}
		jsrt.QueueMicrotask(func() {
			if s.c.onLine != nil {
				s.c.onLine(msg)
			}
		})
	}
	return true
}

type fakeChild struct {
	stdin   *fakeStdin
	written []string
	onLine  func(msg *util.Obj)
	stdout  []func(string)
	closes  []func(*int, string)
	exit    *int
	killed  bool
}

func newFakeChild() *fakeChild {
	c := &fakeChild{}
	c.stdin = &fakeStdin{c: c, writable: true}
	return c
}

func (c *fakeChild) PID() int                               { return 4242 }
func (c *fakeChild) ExitCode() *int                         { return c.exit }
func (c *fakeChild) Killed() bool                           { return c.killed }
func (c *fakeChild) Stdin() clisdk.StdinLike                { return c.stdin }
func (c *fakeChild) OnStdout(fn func(string))               { c.stdout = append(c.stdout, fn) }
func (c *fakeChild) OnStderr(func(string))                  {}
func (c *fakeChild) OnClose(fn func(code *int, sig string)) { c.closes = append(c.closes, fn) }
func (c *fakeChild) OnError(func(error))                    {}
func (c *fakeChild) Kill(string) bool {
	c.killed = true
	jsrt.QueueMicrotask(func() {
		if c.exit != nil {
			return
		}
		z := 0
		c.exit = &z
		c.stdin.writable = false
		for _, fn := range c.closes {
			fn(nil, "")
		}
	})
	return true
}

func (c *fakeChild) send(v any) {
	line := util.Stringify(v) + "\n"
	for _, fn := range c.stdout {
		fn(line)
	}
}

func (c *fakeChild) messages() []*util.Obj {
	out := []*util.Obj{}
	for _, raw := range c.written {
		v, _ := util.ParseString(raw)
		o, _ := v.(*util.Obj)
		if o == nil {
			o = O()
		}
		out = append(out, o)
	}
	return out
}

func (c *fakeChild) find(method string) *util.Obj {
	for _, m := range c.messages() {
		if m.Get("method") == method {
			return m
		}
	}
	return nil
}

func (c *fakeChild) answered(id float64) bool {
	for _, m := range c.messages() {
		if m.Get("id") == id && m.Get("method") == nil {
			return true
		}
	}
	return false
}

func TestStreamJsonDriverSteer(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		parse := func(line string) []Ev {
			v, _ := util.ParseString(line)
			j, _ := v.(*util.Obj)
			if j != nil && j.Get("type") == "result" {
				return []Ev{O("type", "done", "text", "", "sessionId", j.Get("session_id"))}
			}
			return nil
		}
		d := NewStreamJsonDriver(StreamJsonDriverOptions{Child: child, ParseLine: parse, NewID: func() string { return "U1" }})
		if ok, _ := jsrt.Await(d.Steer("early")); ok {
			t.Fatal("steer without a turn should be false")
		}
		p := d.Send(TurnInput{Text: "hello"})
		if ok, _ := jsrt.Await(d.Steer("also run the tests")); !ok {
			t.Fatal("steer during a turn should be true")
		}
		msgs := child.messages()
		if len(msgs) < 2 || msgs[1].Get("type") != "user" ||
			util.Stringify(msgs[1].Get("message")) != `{"role":"user","content":"also run the tests"}` {
			t.Fatal(child.written)
		}
		child.send(O("type", "result", "session_id", "sess-1"))
		if _, err := jsrt.Await(p); err != nil {
			t.Fatal(err)
		}
		if ok, _ := jsrt.Await(d.Steer("late")); ok {
			t.Fatal("steer after the turn should be false")
		}
	})
}

func TestAppServerDriverSteer(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		child.onLine = func(msg *util.Obj) {
			reply := func(result any) { child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", result)) }
			note := func(method string, params any) { child.send(O("jsonrpc", "2.0", "method", method, "params", params)) }
			switch msg.Get("method") {
			case "initialize":
				reply(O("userAgent", "codex/0.163.0"))
			case "thread/start":
				reply(O("thread", O("id", "th1")))
			case "turn/steer":
				reply(O("turnId", "tu1"))
			case "turn/interrupt":
				reply(O())
				note("turn/completed", O("threadId", "th1", "turn", O("id", "tu1", "status", "interrupted")))
			case "turn/start":
				// slowStart：应答晚到，steer 要先等 turn/start 的应答
				jsrt.SetTimeout(20*time.Millisecond, func() { reply(O("turn", O("id", "tu1"))) })
			}
		}
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		if _, err := jsrt.Await(d.EnsureThread("/w")); err != nil {
			t.Fatal(err)
		}
		if ok, _ := jsrt.Await(d.Steer("early")); ok {
			t.Fatal("steer without a turn should be false")
		}
		p := d.Send(TurnInput{Text: "x"})
		jsrt.Sleep(0)
		if ok, _ := jsrt.Await(d.Steer("also check the docs")); !ok {
			t.Fatal("steer during a turn should be true")
		}
		m := child.find("turn/steer")
		if m == nil || util.Stringify(m.Get("params")) !=
			`{"threadId":"th1","expectedTurnId":"tu1","input":[{"type":"text","text":"also check the docs","text_elements":[]}]}` {
			t.Fatal(child.written)
		}
		if _, err := jsrt.Await(d.Interrupt()); err != nil {
			t.Fatal(err)
		}
		if _, err := jsrt.Await(p); err != nil {
			t.Fatal(err)
		}
	})
}

// acpAgent：最小的 ACP 代理（带权限请求）
func acpAgent(child *fakeChild) {
	child.onLine = func(msg *util.Obj) {
		reply := func(result any) { child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", result)) }
		switch msg.Get("method") {
		case "initialize":
			reply(O("protocolVersion", 1.0, "agentCapabilities", O("loadSession", true, "promptCapabilities", O("image", true))))
		case "session/new":
			reply(O("sessionId", "s1", "modes", O("currentModeId", "default")))
		case "_x.ai/interject":
			reply(O("status", "queued"))
		case "session/prompt":
			child.send(O("jsonrpc", "2.0", "id", 500.0, "method", "session/request_permission", "params", O(
				"sessionId", "s1",
				"toolCall", O("toolCallId", "t1", "title", "Edit", "locations", []any{O("path", "/a.ts")}),
				"options", []any{
					O("optionId", "yes", "kind", "allow_once", "name", "Allow"),
					O("optionId", "no", "kind", "reject_once", "name", "Reject"),
				},
			)))
			// 应答之后才结束这一轮
			var wait func()
			wait = func() {
				if !child.answered(500) {
					jsrt.SetTimeout(time.Millisecond, wait)
					return
				}
				reply(O("stopReason", "end_turn"))
			}
			wait()
		}
	}
}

func steerOnPermission(d *AcpDriver, text string, results *[]bool) {
	d.On(func(e SessionEvent) {
		if e == nil || e.Get("kind") != "permission" {
			return
		}
		id, _ := e.Get("id").(string)
		p := d.Steer(text)
		jsrt.Async(func() (struct{}, error) {
			ok, _ := jsrt.Await(p)
			*results = append(*results, ok)
			d.RespondPermission(id, O("decision", "allow"))
			return struct{}{}, nil
		})
	})
}

func TestAcpDriverSteer(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		acpAgent(child)
		d := NewAcpDriver(AcpDriverOptions{Child: child, SteerMethod: "_x.ai/interject"})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		if ok, _ := jsrt.Await(d.Steer("early")); ok {
			t.Fatal("steer without a turn should be false")
		}
		var results []bool
		steerOnPermission(d, "use the new API", &results)
		if _, err := jsrt.Await(d.Send(TurnInput{Text: "go"})); err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || !results[0] {
			t.Fatal(results)
		}
		m := child.find("_x.ai/interject")
		if m == nil || util.Stringify(m.Get("params")) != `{"sessionId":"s1","text":"use the new API"}` {
			t.Fatal(child.written)
		}

		// 没配扩展方法 = 不支持
		plain := newFakeChild()
		acpAgent(plain)
		g := NewAcpDriver(AcpDriverOptions{Child: plain})
		if _, err := jsrt.Await(g.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		var seen []bool
		steerOnPermission(g, "x", &seen)
		if _, err := jsrt.Await(g.Send(TurnInput{Text: "go"})); err != nil {
			t.Fatal(err)
		}
		if len(seen) != 1 || seen[0] {
			t.Fatal(seen)
		}
	})
}
