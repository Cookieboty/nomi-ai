package harness

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/cliplugins/claude"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/clisdk"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/cli"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunningSessionIdentityAndDeletion(t *testing.T) {
	for _, backend := range []string{"claude", "codex", "gemini"} {
		t.Run(backend, func(t *testing.T) {
			o := titleTestOrch(t)
			defer jsrt.Run(o.Dispose)
			t.Setenv("NOMI_MOCK_HOLD_PROMPT", "hold-session")
			t.Setenv("NOMI_MOCK_FIRST_TOKEN_MS", "10000")
			var id, other string
			var send *jsrt.Promise[*util.Obj]
			jsrt.Run(func() {
				o.d.CodexAppServer = true
				id = str(o.CreateTab(util.NewObj("backend", backend)), "id")
				other = str(o.CreateTab(util.NewObj("backend", backend, "cliSessionId", "unrelated")), "id")
				send = o.SendTab(id, "hold-session", nil, true)
			})
			var sid string
			ready := jsrt.Call(func() *jsrt.Promise[struct{}] {
				return jsrt.Async(func() (struct{}, error) {
					deadline := time.Now().Add(5 * time.Second)
					for time.Now().Before(deadline) {
						sid = str(o.tab(id), "cliSessionId")
						if sid != "" || send.Settled() {
							break
						}
						jsrt.Sleep(10 * time.Millisecond)
					}
					return struct{}{}, nil
				})
			})
			_, _ = jsrt.Block(ready)
			var deleted *jsrt.Promise[struct{}]
			closed := false
			jsrt.Run(func() {
				if sid == "" || send.Settled() {
					_, err := send.Result()
					t.Fatalf("native identity must be published during the first turn: sid=%q settled=%v err=%v", sid, send.Settled(), err)
				}
				if !containsS(o.OpenSessionKeys(), backend+":"+sid) {
					t.Fatal("running session must be excluded from history")
				}
				children := o.tabProcs[id]
				if len(children) != 1 {
					t.Fatalf("expected one tracked process, got %d", len(children))
				}
				children[0].OnClose(func(*int, string) { closed = true })
				deleted = o.CloseHistorySession(backend, sid)
			})
			if _, err := jsrt.Block(deleted); err != nil {
				t.Fatal(err)
			}
			_, _ = jsrt.Block(send)
			jsrt.Run(func() {
				if !closed || o.tab(id) != nil || o.tab(other) == nil {
					t.Fatalf("delete must wait for process exit and close only matching tab: closed=%v", closed)
				}
				if containsS(o.OpenSessionKeys(), backend+":"+sid) || len(o.tabProcs[id]) != 0 {
					t.Fatal("deleted session still registered")
				}
				if len(o.messages[id]) != 0 || o.running != 0 {
					t.Fatal("late turn completion recreated deleted messages or running state")
				}
				o.emitEvent(id, util.NewObj("type", "text-delta", "text", "late output"))
				if o.ProgressHint(id) != "" {
					t.Fatal("closed tab accepted a late event")
				}
				if _, err := os.Stat(o.messagesPath(id)); !os.IsNotExist(err) {
					t.Fatalf("deleted message file was recreated: %v", err)
				}
			})
		})
	}
}

func TestClaudeInitDoesNotBindSubagentOrClosedSession(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude")), "id")
		live := &claudeLiveSession{parseLine: claude.NewParser(), cwd: str(o.tab(id), "cwd")}
		o.live.setClaude(id, live)
		o.onClaudeLine(id, live, `{"type":"system","subtype":"init","session_id":"subagent","parent_tool_use_id":"tool-1"}`, true)
		if str(o.tab(id), "cliSessionId") != "" {
			t.Fatal("subagent init replaced the parent session identity")
		}
		o.onClaudeLine(id, live, `{"type":"system","subtype":"init","session_id":"parent"}`, true)
		if str(o.tab(id), "cliSessionId") != "parent" {
			t.Fatal("parent init did not bind immediately")
		}
		o.live.delClaude(id)
		o.CloseTab(id)
		o.onClaudeLine(id, live, `{"type":"system","subtype":"init","session_id":"late"}`, true)
		if containsS(o.OpenSessionKeys(), "claude:late") {
			t.Fatal("closed session was rebound by late output")
		}
	})
}

// Kill requests exit; OnClose deliberately arrives later, as with a real OS process.
type delayedHistoryChild struct {
	killed         bool
	closeListeners []func(*int, string)
}

func (c *delayedHistoryChild) PID() int                { return 0 }
func (c *delayedHistoryChild) ExitCode() *int          { return nil }
func (c *delayedHistoryChild) Killed() bool            { return c.killed }
func (c *delayedHistoryChild) Stdin() clisdk.StdinLike { return nil }
func (c *delayedHistoryChild) OnStdout(func(string))   {}
func (c *delayedHistoryChild) OnStderr(func(string))   {}
func (c *delayedHistoryChild) OnClose(f func(*int, string)) {
	c.closeListeners = append(c.closeListeners, f)
}
func (c *delayedHistoryChild) OnError(func(error)) {}
func (c *delayedHistoryChild) Kill(string) bool    { c.killed = true; return true }
func (c *delayedHistoryChild) exit() {
	for _, f := range c.closeListeners {
		f(nil, "SIGKILL")
	}
}

func TestConcurrentHistoryDeletionWaitsForEveryProcess(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	var first, second *jsrt.Promise[struct{}]
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude", "cliSessionId", "native")), "id")
		children := []*delayedHistoryChild{{}, {}}
		for _, child := range children {
			o.trackProc(id, child)
		}
		first = o.CloseHistorySession("claude", "native")
		second = o.CloseHistorySession("claude", "native")
		if current := o.HistoryTabSession(id); current == nil || str(current, "sessionId") != "native" {
			t.Error("deletion retry by tab must retain the native identity until exit")
		}
		if first.Settled() || second.Settled() {
			t.Error("concurrent deletion bypassed process exit")
		}
		children[0].exit()
		if first.Settled() || second.Settled() {
			t.Error("must wait for all processes, not just the first")
		}
		children[1].exit()
		if current := o.HistoryTabSession(id); current == nil || str(current, "sessionId") != "native" {
			t.Error("a pending confirmation must still resolve a normally closed tab after process exit")
		}
		if !first.Settled() || !second.Settled() || len(o.historyClosing) != 0 {
			t.Error("exit did not release all deletion requests")
		}
	})
	for _, p := range []*jsrt.Promise[struct{}]{first, second} {
		if _, err := jsrt.Block(p); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHistoryDeletionRetryAfterTimeoutStillWaitsForExit(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	var child *delayedHistoryChild
	var first, second, retry *jsrt.Promise[struct{}]
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude", "cliSessionId", "native")), "id")
		child = &delayedHistoryChild{}
		o.trackProc(id, child)
		first = o.closeHistorySession("claude", "native", 10*time.Millisecond)
		second = o.CloseHistorySession("claude", "native")
	})
	if _, err := jsrt.Block(first); err == nil {
		t.Error("expected first deletion to time out")
	}
	jsrt.Run(func() {
		retry = o.CloseHistorySession("claude", "native")
		if second.Settled() || retry.Settled() {
			t.Error("timeout discarded the process exit barrier")
		}
		child.exit()
		if len(o.historyClosing) != 0 {
			t.Error("process exit must release barrier bookkeeping")
		}
	})
	for _, p := range []*jsrt.Promise[struct{}]{second, retry} {
		if _, err := jsrt.Block(p); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOrdinaryCloseThenDeleteWaitsForExit(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude", "cliSessionId", "native")), "id")
		child := &delayedHistoryChild{}
		o.trackProc(id, child)
		o.children.Set(id, child)
		o.CloseTab(id) // The normal close action, rather than history deletion.
		if !child.killed {
			t.Fatal("expected close to request process termination")
		}
		deletion := o.CloseHistorySession("claude", "native")
		if deletion.Settled() {
			t.Error("history deletion bypassed the exit barrier after ordinary tab close; the child has not emitted OnClose")
		}
		child.exit()
	})
}

func TestConfirmDeleteAfterTabClosedStillDeletesTranscript(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	home := t.TempDir()
	file := filepath.Join(home, ".claude", "projects", "work", "native.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"type":"user","sessionId":"native","message":{"role":"user","content":"test"}}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude", "cliSessionId", "native")), "id")
		service := cli.NewSessionHistoryService(cli.SessionHistoryDeps{
			Home: home, HasHome: true, Env: util.NewObj(),
			TabSession:   o.HistoryTabSession,
			CloseTab:     o.CloseTabAndWait,
			CloseSession: o.CloseHistorySession,
			RemovePath: func(path string) *jsrt.Promise[struct{}] {
				return jsrt.Async(func() (struct{}, error) { return struct{}{}, os.Remove(path) })
			},
		})
		// The delete dialog was opened while the tab still existed. Another entry
		// point closes the tab before the user confirms the pending delete dialog.
		o.CloseTab(id)
		result, err := jsrt.Await(service.RemoveTab(id))
		if err != nil || result.Get("ok") != true {
			t.Fatalf("result=%v err=%v", result, err)
		}
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Errorf("confirmed deletion reports success but transcript still exists: %s", file)
		}
	})
}

func TestClosedHistoryTabIdentityCacheIsBounded(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		var first, last string
		for i := 0; i < 501; i++ {
			last = str(o.CreateTab(util.NewObj("backend", "claude", "cliSessionId", "native")), "id")
			if i == 0 {
				first = last
			}
			o.CloseTab(last)
		}
		if len(o.closedHistoryTabs.Keys()) != 500 || o.HistoryTabSession(first) != nil || o.HistoryTabSession(last) == nil {
			t.Fatalf("closed tab identity cache must retain only the most recent 500 entries: len=%d first=%v last=%v", len(o.closedHistoryTabs.Keys()), o.HistoryTabSession(first), o.HistoryTabSession(last))
		}
	})
}

func TestDeleteNewTabWaitsForProcessBeforeNativeIdentity(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	var deletion *jsrt.Promise[struct{}]
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude")), "id")
		child := &delayedHistoryChild{}
		o.trackProc(id, child)
		o.children.Set(id, child)
		deletion = o.CloseTabAndWait(id)
		if deletion.Settled() || !child.killed {
			t.Error("new session deletion must terminate and wait for its process")
		}
		child.exit()
	})
	if _, err := jsrt.Block(deletion); err != nil {
		t.Fatal(err)
	}
}

// CloseTab no longer goes through CancelTab: a tab paused from the agent board must
// still be thawed and dropped from the frozen list when it is closed.
func TestCloseTabThawsFrozenTab(t *testing.T) {
	o := titleTestOrch(t)
	defer jsrt.Run(o.Dispose)
	jsrt.Run(func() {
		id := str(o.CreateTab(util.NewObj("backend", "claude")), "id")
		if o.frozen == nil {
			o.frozen = map[string]*FrozenTab{}
		}
		o.frozen[id] = &FrozenTab{}
		o.CloseTab(id)
		if _, ok := o.FrozenTabs()[id]; ok {
			t.Fatal("closed tab is still listed as frozen")
		}
	})
}
