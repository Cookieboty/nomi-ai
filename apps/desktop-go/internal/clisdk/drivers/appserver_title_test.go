package drivers

import (
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

func TestAppServerSessionTitleAndNotifications(t *testing.T) {
	jsrt.Run(func() {
		install := func(target *fakeChild) {
			target.onLine = func(msg *util.Obj) {
				id := msg.Get("id")
				if id == nil {
					return
				}
				switch msg.Get("method") {
				case "initialize":
					replyInit(target, msg)
				case "thread/start":
					target.send(O("jsonrpc", "2.0", "id", id, "result", O(
						"thread", O("id", "th-main", "name", "Start Thread Title"),
					)))
				case "thread/resume":
					target.send(O("jsonrpc", "2.0", "id", id, "result", O(
						"thread", O("id", "th-resumed", "title", "Resumed Thread Title"),
					)))
				case "turn/start":
					target.send(O("jsonrpc", "2.0", "id", id, "result", O("turn", O("id", "turn-1"))))
					// Subagent thread rename must not emit a main session title.
					target.send(O("jsonrpc", "2.0", "method", "thread/name/updated", "params", O(
						"threadId", "th-child", "threadName", "Child Subagent Title",
					)))
					// In-turn main thread rename emits session-info.
					target.send(O("jsonrpc", "2.0", "method", "thread/name/updated", "params", O(
						"threadId", "th-main", "threadName", "In-Turn Updated Title",
					)))
					target.send(O("jsonrpc", "2.0", "method", "turn/completed", "params", O(
						"threadId", "th-main", "turn", O("id", "turn-1", "status", "completed"),
					)))
				}
			}
		}

		child := newFakeChild()
		install(child)

		d := NewAppServerDriver(AppServerDriverOptions{Child: child, NewID: func() string { return "id-1" }})
		var titles []string
		d.On(func(e SessionEvent) {
			if e.Get("kind") == "harness" {
				if ev := util.AsObj(e.Get("event")); ev != nil && ev.Get("type") == "session-info" {
					if title, _ := ev.Get("title").(string); title != "" {
						titles = append(titles, title)
					}
				}
			}
		})

		if _, err := jsrt.Await(d.Start(clisdk.StartOptions{Cwd: "/w"})); err != nil {
			t.Fatal(err)
		}
		tid, err := jsrt.Await(d.EnsureThread("/w"))
		if err != nil || tid != "th-main" {
			t.Fatalf("EnsureThread = %q, %v", tid, err)
		}
		if d.SessionTitle != "Start Thread Title" {
			t.Fatalf("SessionTitle after thread/start = %q", d.SessionTitle)
		}

		d.NoteChild("th-child", "call-1")
		if _, err := jsrt.Await(d.Send(clisdk.TurnInput{Text: "hello"})); err != nil {
			t.Fatal(err)
		}
		if d.SessionTitle != "In-Turn Updated Title" {
			t.Fatalf("SessionTitle after in-turn rename = %q", d.SessionTitle)
		}

		// Post-turn out-of-turn thread/name/updated also updates SessionTitle and emits session-info.
		child.send(O("jsonrpc", "2.0", "method", "thread/name/updated", "params", O(
			"threadId", "th-main", "thread", O("id", "th-main", "name", "Post-Turn Renamed Title"),
		)))
		if d.SessionTitle != "Post-Turn Renamed Title" {
			t.Fatalf("SessionTitle after post-turn rename = %q", d.SessionTitle)
		}
		if len(titles) != 2 || titles[0] != "In-Turn Updated Title" || titles[1] != "Post-Turn Renamed Title" {
			t.Fatalf("captured titles = %v", titles)
		}

		// Also verify thread/resume title extraction.
		child2 := newFakeChild()
		install(child2)
		d2 := NewAppServerDriver(AppServerDriverOptions{Child: child2, NewID: func() string { return "id-2" }})
		rid := "th-resumed"
		if _, err := jsrt.Await(d2.Start(clisdk.StartOptions{Cwd: "/w", ResumeID: &rid})); err != nil {
			t.Fatal(err)
		}
		if d2.SessionTitle != "Resumed Thread Title" {
			t.Fatalf("SessionTitle after thread/resume = %q", d2.SessionTitle)
		}
	})
}
