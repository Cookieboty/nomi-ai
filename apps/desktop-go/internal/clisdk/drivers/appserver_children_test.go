package drivers

import (
	"errors"
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

// 子代理线程：事件按派出它的调用归位；直接对它说话（turn/start、turn/steer），v2 拒收时 fork。
func TestAppServerChildThreads(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		var note func(method string, params any)
		child.onLine = func(msg *util.Obj) {
			reply := func(result any) { child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", result)) }
			fail := func(m string) {
				child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "error", O("code", -32600.0, "message", m)))
			}
			p, _ := msg.Get("params").(*util.Obj)
			switch msg.Get("method") {
			case "initialize":
				reply(O("userAgent", "codex/0.163.0"))
			case "thread/start":
				reply(O("thread", O("id", "th1")))
			case "turn/start":
				switch p.Get("threadId") {
				case "c2":
					fail("direct app-server input is not allowed for multi-agent v2 sub-agents")
				default:
					reply(O("turn", O("id", "ct2")))
				}
			case "turn/steer":
				reply(O("turnId", "ct2"))
			case "thread/fork":
				reply(O("thread", O("id", "f2")))
			}
		}
		note = func(method string, params any) { child.send(O("jsonrpc", "2.0", "method", method, "params", params)) }
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		var got []*util.Obj
		d.On(func(e SessionEvent) {
			if e.Get("child") != nil {
				got = append(got, util.AsObj(e.Get("event")))
			}
		})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		if _, err := jsrt.Await(d.EnsureThread("/w")); err != nil {
			t.Fatal(err)
		}
		note("thread/started", O("thread", O("id", "c1", "parentThreadId", "th1", "agentNickname", "Scout")))
		note("thread/started", O("thread", O("id", "x9", "parentThreadId", "other")))
		note("item/completed", O("threadId", "th1", "turnId", "t1", "item",
			O("type", "collabAgentToolCall", "id", "call1", "tool", "spawnAgent", "receiverThreadIds", []any{"c1"})))
		note("turn/started", O("threadId", "c1", "turn", O("id", "ct1")))
		note("item/agentMessage/delta", O("threadId", "c1", "turnId", "ct1", "itemId", "m1", "delta", "hel"))
		note("item/agentMessage/delta", O("threadId", "c1", "turnId", "ct1", "itemId", "m1", "delta", "lo"))
		note("item/completed", O("threadId", "c1", "turnId", "ct1", "item", O("type", "agentMessage", "id", "m1", "text", "")))
		note("item/agentMessage/delta", O("threadId", "x9", "itemId", "m9", "delta", "ignored"))
		jsrt.Sleep(0)
		if !d.ChildRunning("c1") {
			t.Fatal("c1 should be running")
		}
		// 在跑：steer 进它这一轮
		if via, err := jsrt.Await(d.SendToThread("c1", []any{O("type", "text", "text", "more")}, nil, true)); err != nil || via != "steer" {
			t.Fatal(via, err)
		}
		if m := child.find("turn/steer"); m == nil || util.AsObj(m.Get("params")).Get("expectedTurnId") != "ct1" {
			t.Fatal(child.written)
		}
		// 在跑但不插：busy
		if via, _ := jsrt.Await(d.SendToThread("c1", []any{}, nil, false)); via != "busy" {
			t.Fatal(via)
		}
		note("turn/completed", O("threadId", "c1", "turn", O("id", "ct1", "status", "completed")))
		jsrt.Sleep(0)
		// 空闲：在它自己的线程上开新一轮
		if via, err := jsrt.Await(d.SendToThread("c1", []any{O("type", "text", "text", "next")}, O("cwd", "/w"), true)); err != nil || via != "start" {
			t.Fatal(via, err)
		}
		// v2：直接输入被拒 → fork，之后都发给副本
		d.NoteChild("c2", "call2")
		if via, err := jsrt.Await(d.SendToThread("c2", []any{}, nil, true)); err != nil || via != "fork" {
			t.Fatal(via, err)
		}
		if d.ForkOf("c2") != "f2" {
			t.Fatal(d.ForkOf("c2"))
		}
		var kinds []string
		for _, e := range got {
			k := util.Str(e.Get("type"))
			if e.Get("type") == "agent" {
				k += ":" + util.Str(e.Get("op")) + ":" + util.Str(e.Get("label"))
			} else {
				k += ":" + util.Str(e.Get("parentId")) + ":" + util.Str(e.Get("text"))
			}
			kinds = append(kinds, k)
		}
		want := "agent:start:Scout|agent-text-delta:call1:hel|agent-text-delta:call1:lo|agent-text:call1:hello|agent:end:"
		if strings.Join(kinds, "|") != want {
			t.Fatal(strings.Join(kinds, "|"))
		}
	})
}

// 应答与生命周期通知可在同一次 stdout 回调内处理，Await 的续体只能在整批处理后执行。
func TestAppServerChildFastCompletion(t *testing.T) {
	for _, status := range []string{"completed", "failed", "interrupted"} {
		for _, replyFirst := range []bool{true, false} {
			t.Run(status+"/replyFirst="+util.JSString(replyFirst), func(t *testing.T) {
				jsrt.Run(func() {
					child := newFakeChild()
					d := NewAppServerDriver(AppServerDriverOptions{Child: child})
					defer d.Close()
					d.NoteChild("c1", "call1")
					starts := 0
					child.onLine = func(msg *util.Obj) {
						if msg.Get("method") != "turn/start" {
							return
						}
						starts++
						reply := func() { child.send(O("id", msg.Get("id"), "result", O("turn", O("id", "ct1")))) }
						if replyFirst {
							reply()
						}
						child.send(O("method", "turn/started", "params", O("threadId", "c1", "turn", O("id", "ct1"))))
						child.send(O("method", "turn/completed", "params", O("threadId", "c1", "turn", O("id", "ct1", "status", status))))
						if !replyFirst {
							reply()
						}
					}
					for i := 0; i < 2; i++ {
						via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, false))
						if err != nil || via != "start" {
							t.Fatalf("send %d: via=%q err=%v", i, via, err)
						}
						if d.ChildRunning("c1") {
							t.Fatal("completed child was marked running by the start response")
						}
					}
					if starts != 2 {
						t.Fatalf("starts=%d, want 2", starts)
					}
				})
			})
		}
	}
}

func TestAppServerChildTerminalErrorEndsAgent(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		defer d.Close()
		d.NoteChild("c1", "call1")
		var got []*util.Obj
		d.On(func(e SessionEvent) {
			if e.Get("child") != nil {
				got = append(got, util.AsObj(e.Get("event")))
			}
		})
		child.onLine = func(msg *util.Obj) {
			if msg.Get("method") == "turn/start" {
				child.send(O("id", msg.Get("id"), "result", O("turn", O("id", "ct1"))))
			}
		}
		if via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, false)); err != nil || via != "start" {
			t.Fatalf("via=%q err=%v", via, err)
		}
		child.send(O("method", "turn/started", "params", O("threadId", "c1", "turn", O("id", "ct1"))))
		child.send(O("method", "error", "params", O("threadId", "c1", "error", O("message", "child failed"), "willRetry", false)))
		jsrt.Sleep(0)
		if d.ChildRunning("c1") {
			t.Fatal("terminal child error left the child running")
		}
		if len(got) != 2 || got[0].Get("op") != "start" || got[1].Get("op") != "end" || got[1].Get("status") != "failed" {
			t.Fatalf("events=%v", got)
		}
	})
}

func TestAppServerChildStartResponsePreservesNewerTurn(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		defer d.Close()
		d.NoteChild("c1", "call1")
		child.onLine = func(msg *util.Obj) {
			switch msg.Get("method") {
			case "turn/start":
				child.send(O("method", "turn/started", "params", O("threadId", "c1", "turn", O("id", "ct1"))))
				child.send(O("method", "turn/completed", "params", O("threadId", "c1", "turn", O("id", "ct1", "status", "completed"))))
				child.send(O("method", "turn/started", "params", O("threadId", "c1", "turn", O("id", "ct2"))))
				child.send(O("id", msg.Get("id"), "result", O("turn", O("id", "ct1"))))
			case "turn/steer":
				if util.AsObj(msg.Get("params")).Get("expectedTurnId") != "ct2" {
					t.Fatal("late start response overwrote the newer turn id")
				}
				child.send(O("id", msg.Get("id"), "result", O()))
			}
		}
		if via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, false)); err != nil || via != "start" {
			t.Fatal(via, err)
		}
		if via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, true)); err != nil || via != "steer" {
			t.Fatal(via, err)
		}
	})
}

// 在 turn/start 应答前也必须占住线程；原 id 与 fork id 指向同一目标时不能重复启动。
func TestAppServerChildConcurrentStarts(t *testing.T) {
	for _, forked := range []bool{false, true} {
		t.Run("forked="+util.JSString(forked), func(t *testing.T) {
			jsrt.Run(func() {
				child := newFakeChild()
				d := NewAppServerDriver(AppServerDriverOptions{Child: child})
				defer d.Close()
				d.NoteChild("c1", "call1")
				target := "c1"
				if forked {
					d.SetFork("c1", "f1")
					target = "f1"
				}
				first := d.SendToThread("c1", []any{}, nil, false)
				for _, id := range []string{"c1", target} {
					second := d.SendToThread(id, []any{}, nil, true)
					if !second.Settled() {
						t.Fatal("concurrent send must return busy without another RPC")
					}
					if via, err := jsrt.Await(second); err != nil || via != "busy" {
						t.Fatalf("concurrent send to %s: via=%q err=%v", id, via, err)
					}
				}
				if len(child.messages()) != 1 {
					t.Fatalf("duplicate start requests: %v", child.written)
				}
				// 请求失败也要释放占用，允许重试。
				child.send(O("id", child.find("turn/start").Get("id"), "error", O("code", -32600.0, "message", "start failed")))
				if _, err := jsrt.Await(first); err == nil {
					t.Fatal("expected start error")
				}
				child.onLine = func(msg *util.Obj) {
					child.send(O("id", msg.Get("id"), "result", O("turn", O("id", "ct2"))))
				}
				if via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, false)); err != nil || via != "start" {
					t.Fatalf("retry: via=%q err=%v", via, err)
				}
			})
		})
	}
}

// 输入占用覆盖整条恢复链，而不只是 turn/start：防止并发恢复 / fork 和恢复中的回收。
func TestAppServerChildPendingRecovery(t *testing.T) {
	for _, recovery := range []string{"resume", "fork"} {
		t.Run(recovery, func(t *testing.T) {
			jsrt.Run(func() {
				child := newFakeChild()
				d := NewAppServerDriver(AppServerDriverOptions{Child: child})
				defer d.Close()
				d.NoteChild("c1", "call1")
				reached := jsrt.NewPromise[struct{}]()
				var held *util.Obj
				starts := 0
				child.onLine = func(msg *util.Obj) {
					switch msg.Get("method") {
					case "turn/start":
						starts++
						if starts == 1 {
							why := "thread not found"
							if recovery == "fork" {
								why = directInputRejected
							}
							child.send(O("id", msg.Get("id"), "error", O("code", -32600.0, "message", why)))
						} else {
							child.send(O("id", msg.Get("id"), "result", O("turn", O("id", "ct1"))))
						}
					case "thread/" + recovery:
						held = msg
						reached.Resolve(struct{}{})
					}
				}
				first := d.SendToThread("c1", []any{}, nil, false)
				if _, err := jsrt.Await(reached); err != nil {
					t.Fatal(err)
				}
				if !d.HasActiveChildren() {
					t.Fatal("pending recovery must prevent idle reclaim")
				}
				second := d.SendToThread("c1", []any{}, nil, true)
				if !second.Settled() {
					t.Fatal("concurrent recovery must return busy immediately")
				}
				if via, err := jsrt.Await(second); err != nil || via != "busy" {
					t.Fatal(via, err)
				}
				if len(child.messages()) != 2 {
					t.Fatalf("duplicate recovery requests: %v", child.written)
				}
				target, want := "c1", "start"
				if recovery == "fork" {
					target, want = "f1", "fork"
				}
				child.send(O("id", held.Get("id"), "result", O("thread", O("id", target))))
				if via, err := jsrt.Await(first); err != nil || via != want {
					t.Fatal(via, err)
				}
				if !d.HasActiveChildren() {
					t.Fatal("accepted turn must still prevent reclaim after request finishes")
				}
				child.send(O("method", "turn/completed", "params", O("threadId", target, "turn", O("id", "ct1", "status", "completed"))))
				if d.HasActiveChildren() {
					t.Fatal("completed recovery retained an input reservation")
				}
			})
		})
	}
}

// resume 等待期间父代理也可能自行唤醒子线程，不能在应答后重复 start。
func TestAppServerChildStartsWhileResuming(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		defer d.Close()
		d.NoteChild("c1", "call1")
		starts := 0
		child.onLine = func(msg *util.Obj) {
			switch msg.Get("method") {
			case "turn/start":
				starts++
				child.send(O("id", msg.Get("id"), "error", O("code", -32600.0, "message", "thread not found")))
			case "thread/resume":
				child.send(O("method", "turn/started", "params", O("threadId", "c1", "turn", O("id", "external-turn"))))
				child.send(O("id", msg.Get("id"), "result", O("thread", O("id", "c1"))))
			}
		}
		if via, err := jsrt.Await(d.SendToThread("c1", []any{}, nil, false)); err != nil || via != "busy" {
			t.Fatal(via, err)
		}
		if starts != 1 || !d.ChildRunning("c1") {
			t.Fatalf("must preserve external turn without a second start: starts=%d running=%v", starts, d.ChildRunning("c1"))
		}
	})
}

// 直接对话只接受这个连接上已发现的子代理：拒绝主线程、未登记 id、以及只在别的连接上登记过的 id。
func TestSendToThreadRejectsUnregistered(t *testing.T) {
	jsrt.Run(func() {
		started := 0
		child := newFakeChild()
		child.onLine = func(msg *util.Obj) {
			reply := func(result any) { child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", result)) }
			switch msg.Get("method") {
			case "initialize":
				reply(O("userAgent", "codex/0.163.0"))
			case "thread/start":
				reply(O("thread", O("id", "th1")))
			case "turn/start":
				started++
				reply(O("turn", O("id", "ct")))
			case "thread/resume":
				reply(O())
			}
		}
		d := NewAppServerDriver(AppServerDriverOptions{Child: child})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		if _, err := jsrt.Await(d.EnsureThread("/w")); err != nil {
			t.Fatal(err)
		}
		if d.ThreadID == nil || *d.ThreadID != "th1" {
			t.Fatalf("main thread %v", d.ThreadID)
		}
		mustReject := func(id, why string) {
			t.Helper()
			via, err := jsrt.Await(d.SendToThread(id, []any{O("type", "text", "text", "hi")}, nil, false))
			if !errors.Is(err, ErrUnknownChild) || via != "" {
				t.Fatalf("%s: via=%q err=%v", why, via, err)
			}
			if d.IsChild(id) && id != "c1" {
				t.Fatalf("%s: must not register the spoofed id", why)
			}
		}
		mustReject("th1", "main thread")
		mustReject("spoof-thread", "never discovered")
		mustReject("", "empty")

		// 另一个连接上登记的子代理，不能用这边的 SendToThread 发
		other := NewAppServerDriver(AppServerDriverOptions{Child: newFakeChild()})
		other.NoteChild("c-other", "call-x")
		mustReject("c-other", "other connection")

		d.NoteChild("c1", "call1")
		via, err := jsrt.Await(d.SendToThread("c1", []any{O("type", "text", "text", "ok")}, nil, false))
		if err != nil || via != "start" || started != 1 {
			t.Fatalf("known child: via=%q err=%v starts=%d", via, err, started)
		}

		// 登记之后再拿主线程发，仍然拒绝，也不能因此把主线程变成 child
		mustReject("th1", "main after a real child exists")
		if d.IsChild("th1") {
			t.Fatal("main thread must not become a child")
		}
	})
}
