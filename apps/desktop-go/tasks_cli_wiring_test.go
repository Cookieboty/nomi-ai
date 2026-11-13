package main

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli/harness"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tasks"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/repotest"
)

type taskHarnessTestLog struct{}

func (taskHarnessTestLog) Info(string, any) {}
func (taskHarnessTestLog) Warn(string, any) {}

type taskRuntimeTestLog struct{}

func (taskRuntimeTestLog) Warn(string, ...any) {}

type taskHarnessTestPorts struct{}

func (taskHarnessTestPorts) PickDirectory(string, bool, string) *string { return nil }
func (taskHarnessTestPorts) AnyFocused() bool                           { return false }

func TestTaskCLIPlanLifecycle(t *testing.T) {
	for _, action := range []string{"inbox-approve", "pane-approve", "pane-deny", "cancel", "close", "followup-cancel"} {
		t.Run(action, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("NOMI_USE_MOCK_CLI", "1")
			t.Setenv("NOMI_MOCK_DELAY_MS", "10")
			if action == "followup-cancel" {
				t.Setenv("NOMI_MOCK_FIRST_TOKEN_MS", "200")
			}
			t.Chdir(repotest.RepoRoot())
			idle := float64(0)
			o := harness.New(harness.Deps{Root: filepath.Join(root, "harness"), Home: root, DefaultCwd: root,
				Logger: taskHarnessTestLog{}, Ports: taskHarnessTestPorts{}, IdleReclaimMs: &idle})
			previous := harnessOrch
			harnessOrch = o
			defer func() { jsrt.Run(o.Dispose); harnessOrch = previous }()
			ex := tasks.NewCliExecutor(tasks.CliDeps{Harness: taskCliHarness{},
				DirOk: func(string) bool { return true }, GitChanged: func(string) []string { return nil },
				BuildPrompt: func(string, string, string, string) string { return "make a plan" },
				ParseReport: func(string) *tasks.CliReport { return nil }})
			seq := 0
			rt := tasks.NewRuntime(tasks.RuntimeDeps{Store: tasks.NewStore(filepath.Join(root, "tasks"), taskRuntimeTestLog{}),
				Executors: map[string]tasks.Executor{"cli": ex}, Now: func() int64 { return time.Now().UnixMilli() },
				SetTimer: func(func(), int64) func() { return func() {} },
				NewID:    func(prefix string) string { seq++; return fmt.Sprintf("%s_%d", prefix, seq) }, Log: taskRuntimeTestLog{}})
			rt.Start()
			defer rt.Stop()
			cli := "codex"
			result := rt.Create(tasks.CreateInput{Title: "plan", Goal: "make a plan", Trigger: tasks.Trigger{Kind: "manual"},
				Executor: tasks.ExecutorSpec{Kind: "cli", Cli: &cli, Cwd: &root}, Grant: tasks.Grant{Level: 1, Paths: []string{root}},
				Acceptance: "user"})
			id := result.ID
			rt.Command(id, tasks.Command{Type: "runNow"})
			waitTaskStatus(t, rt, id, "waiting_user")
			rec := rt.Get(id)
			planTokens := rec.Attempts[0].Usage.InputTokens + rec.Attempts[0].Usage.OutputTokens
			if planTokens == 0 {
				t.Fatal("plan usage missing while awaiting approval")
			}
			request := *rec.Task.Wait.RequestID
			tab := *rec.Attempts[0].Carrier.TabID
			switch action {
			case "inbox-approve":
				if r := rt.Command(id, tasks.Command{Type: "decide", RequestID: &request, Approve: true}); !r.OK {
					t.Fatal(r)
				}
			case "pane-approve":
				jsrt.Run(func() { o.ReplyApprovePlan(tab, request, "acceptEdits") })
			case "pane-deny":
				jsrt.Run(func() { o.ReplyApprovePlan(tab, request, "deny") })
			case "cancel":
				rt.Command(id, tasks.Command{Type: "cancel"})
			case "close":
				jsrt.Run(func() { o.CloseTab(tab) })
			case "followup-cancel":
				jsrt.Run(func() { o.ReplyApprovePlan(tab, request, "acceptEdits") })
				waitTaskStatus(t, rt, id, "running")
				deadline := time.Now().Add(5 * time.Second)
				for jsrt.Call(func() int { return len(o.TabMessages(tab)) }) < 3 {
					if time.Now().After(deadline) {
						t.Fatal("follow-up did not start")
					}
					time.Sleep(time.Millisecond)
				}
				rt.Command(id, tasks.Command{Type: "cancel"})
			}
			want := "awaiting_accept"
			if action == "cancel" || action == "followup-cancel" {
				want = "cancelled"
			}
			if action == "close" {
				want = "failed"
			}
			waitTaskStatus(t, rt, id, want)
			deadline := time.Now().Add(5 * time.Second)
			for jsrt.Call(func() int { return o.Events().ListenerCount("event") }) != 0 {
				if time.Now().After(deadline) {
					t.Fatal("task listener leaked")
				}
				time.Sleep(time.Millisecond)
			}
			if tokens := rt.Get(id).Attempts[0].Usage; tokens.InputTokens+tokens.OutputTokens < planTokens {
				t.Fatal("plan usage lost")
			}
			jsrt.Run(func() {
				if o.ReplyApprovePlan(tab, request, "acceptEdits") {
					t.Fatal("stale approval accepted")
				}
			})
			if action != "cancel" && action != "close" && action != "followup-cancel" {
				wantMsgs := 4
				if action == "pane-deny" {
					wantMsgs = 2
				}
				messages := jsrt.Call(func() []*util.Obj { return o.TabMessages(tab) })
				if len(messages) != wantMsgs {
					t.Fatalf("messages=%d want %d", len(messages), wantMsgs)
				}
				var input, output int64
				for _, m := range messages {
					if u, _ := m.Get("usage").(*util.Obj); u != nil {
						input += num(u.Get("inputTokens"))
						output += num(u.Get("outputTokens"))
					}
				}
				usage := rt.Get(id).Attempts[0].Usage
				if usage.InputTokens != input || usage.OutputTokens != output {
					t.Fatalf("usage counted twice: %+v, want %d/%d", usage, input, output)
				}
			}
		})
	}
}

func waitTaskStatus(t *testing.T, rt *tasks.Runtime, id, want string) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for {
		rec := rt.Get(id)
		if rec != nil && rec.Task.Status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %s, got %+v", want, rec)
		}
		time.Sleep(time.Millisecond)
	}
}
