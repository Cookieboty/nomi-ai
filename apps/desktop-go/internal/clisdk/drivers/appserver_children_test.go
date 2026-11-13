package drivers

import (
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
