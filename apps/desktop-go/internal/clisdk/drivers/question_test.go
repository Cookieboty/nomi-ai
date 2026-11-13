package drivers

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func replyInit(child *fakeChild, msg *util.Obj) {
	if msg.Get("method") == "initialize" {
		child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", O("userAgent", "codex/0", "protocolVersion", 1.0)))
	}
}

func waitID(t *testing.T, child *fakeChild, id float64) *util.Obj {
	t.Helper()
	for i := 0; i < 50; i++ {
		for _, m := range child.messages() {
			if m.Get("id") == id && m.Get("method") == nil {
				return m
			}
		}
		jsrt.Sleep(time.Millisecond)
	}
	t.Fatalf("no response for %v in %s", id, child.written)
	return nil
}

func TestAppServerUserInputAndElicitation(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		child.onLine = func(msg *util.Obj) { replyInit(child, msg) }
		d := NewAppServerDriver(AppServerDriverOptions{Child: child, NewID: func() string { return "1" }})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		var kinds []string
		d.On(func(e SessionEvent) {
			kind, _ := e.Get("kind").(string)
			kinds = append(kinds, kind)
			id, _ := e.Get("id").(string)
			switch kind {
			case "question":
				if e.Get("method") != "item/tool/requestUserInput" {
					t.Fatalf("method %v", e.Get("method"))
				}
				d.RespondQuestion(id, O("answers", O("confirm_path", O("answers", []any{"Yes"}))), false)
			case "permission":
				d.RespondPermission(id, O("decision", "allow"))
			}
		})
		child.send(O("jsonrpc", "2.0", "id", 9.0, "method", "item/tool/requestUserInput", "params", O(
			"threadId", "th", "turnId", "tu", "itemId", "call1",
			"questions", []any{O("id", "confirm_path", "question", "Proceed?", "options", []any{O("label", "Yes", "description", "Go")})},
		)))
		got := waitID(t, child, 9)
		if util.Stringify(got.Get("result")) != `{"answers":{"confirm_path":{"answers":["Yes"]}}}` {
			t.Fatal(util.Stringify(got))
		}
		if len(kinds) != 1 || kinds[0] != "question" {
			t.Fatal(kinds)
		}
	})

	jsrt.Run(func() {
		child := newFakeChild()
		child.onLine = func(msg *util.Obj) { replyInit(child, msg) }
		d := NewAppServerDriver(AppServerDriverOptions{Child: child, NewID: func() string { return "2" }})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		d.On(func(e SessionEvent) {
			if e.Get("kind") != "question" {
				return
			}
			id, _ := e.Get("id").(string)
			d.RespondQuestion(id, nil, true)
		})
		child.send(O("jsonrpc", "2.0", "id", 11.0, "method", "item/tool/requestUserInput", "params", O(
			"questions", []any{O("id", "q", "question", "Stop?")},
		)))
		got := waitID(t, child, 11)
		errObj, _ := got.Get("error").(*util.Obj)
		if errObj == nil || errObj.Get("message") != "cancelled" {
			t.Fatal(util.Stringify(got))
		}

		d.On(func(e SessionEvent) {
			if e.Get("kind") != "permission" {
				return
			}
			id, _ := e.Get("id").(string)
			d.RespondPermission(id, O("decision", "allow"))
		})
		child.send(O("jsonrpc", "2.0", "id", 12.0, "method", "mcpServer/elicitation/request", "params", O(
			"serverName", "tools",
			"request", O("mode", "form", "message", "Allow the tool?", "meta", O("codex_approval_kind", "mcp_tool_call")),
		)))
		approved := waitID(t, child, 12)
		if util.Stringify(approved.Get("result")) != `{"action":"accept","content":null}` {
			t.Fatal(util.Stringify(approved))
		}

		var saw bool
		d.On(func(e SessionEvent) {
			if e.Get("kind") == "question" || e.Get("kind") == "permission" {
				saw = true
			}
		})
		child.send(O("jsonrpc", "2.0", "id", 13.0, "method", "mcpServer/elicitation/request", "params", O(
			"request", O("mode", "url", "url", "https://example.com/oauth", "message", "Sign in"),
		)))
		url := waitID(t, child, 13)
		if util.Stringify(url.Get("result")) != `{"action":"cancel","content":null}` || saw {
			t.Fatalf("url result %s saw=%v", util.Stringify(url), saw)
		}

		d.On(func(e SessionEvent) {
			if e.Get("kind") != "permission" {
				t.Fatalf("command approval kind %v", e.Get("kind"))
			}
			id, _ := e.Get("id").(string)
			d.RespondPermission(id, O("decision", "allow"))
		})
		child.send(O("jsonrpc", "2.0", "id", 14.0, "method", "item/commandExecution/requestApproval", "params", O("command", "ls")))
		cmd := waitID(t, child, 14)
		if util.Stringify(cmd.Get("result")) != `{"decision":"accept"}` {
			t.Fatal(util.Stringify(cmd))
		}
	})
}

func TestAcpElicitationRoundTrip(t *testing.T) {
	jsrt.Run(func() {
		child := newFakeChild()
		child.onLine = func(msg *util.Obj) {
			if msg.Get("method") == "initialize" {
				child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", O(
					"protocolVersion", 1.0, "agentCapabilities", O("loadSession", true),
				)))
			}
			if msg.Get("method") == "session/new" {
				child.send(O("jsonrpc", "2.0", "id", msg.Get("id"), "result", O("sessionId", "s1")))
			}
		}
		d := NewAcpDriver(AcpDriverOptions{Child: child, NewID: func() string { return "9" }})
		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		init := child.find("initialize")
		elic := util.AsObj(util.AsObj(init.Get("params")).Get("clientCapabilities")).Get("elicitation")
		if _, ok := getp(elic, "form").(*util.Obj); !ok {
			t.Fatalf("caps %s", util.Stringify(init.Get("params")))
		}
		d.On(func(e SessionEvent) {
			if e.Get("kind") != "question" {
				return
			}
			if e.Get("method") != "elicitation/create" {
				t.Fatalf("method %v", e.Get("method"))
			}
			id, _ := e.Get("id").(string)
			d.RespondQuestion(id, O("action", "accept", "content", O("strategy", "plain")), false)
		})
		child.send(O("jsonrpc", "2.0", "id", 21.0, "method", "elicitation/create", "params", O(
			"sessionId", "s1", "mode", "form", "message", "Pick",
			"requestedSchema", O("type", "object", "properties", O("strategy", O("type", "string"))),
		)))
		got := waitID(t, child, 21)
		if util.Stringify(got.Get("result")) != `{"action":"accept","content":{"strategy":"plain"}}` {
			t.Fatal(util.Stringify(got))
		}

		child.send(O("jsonrpc", "2.0", "id", 22.0, "method", "elicitation/create", "params", O(
			"mode", "url", "url", "https://example.com", "message", "Sign in",
		)))
		denied := waitID(t, child, 22)
		if denied.Get("error") == nil {
			t.Fatal(util.Stringify(denied))
		}

		sawQuestion := false
		d.On(func(e SessionEvent) {
			if e.Get("kind") == "question" {
				sawQuestion = true
			}
			if e.Get("kind") == "permission" {
				id, _ := e.Get("id").(string)
				d.RespondPermission(id, O("decision", "allow"))
			}
		})
		child.send(O("jsonrpc", "2.0", "id", 23.0, "method", "session/request_permission", "params", O(
			"sessionId", "s1",
			"toolCall", O("toolCallId", "t1", "title", "Edit"),
			"options", []any{O("optionId", "yes", "kind", "allow_once", "name", "Allow")},
		)))
		perm := waitID(t, child, 23)
		if sawQuestion || util.Stringify(perm.Get("result")) != `{"outcome":{"outcome":"selected","optionId":"yes"}}` {
			t.Fatalf("permission %s question=%v", util.Stringify(perm), sawQuestion)
		}
	})
}
