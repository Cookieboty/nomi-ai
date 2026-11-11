package tasks

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
)

func sp(s string) *string { return &s }

type nomiHarness struct {
	rt    *Runtime
	mu    sync.Mutex
	asks  []func(tool, s, d string) bool
	tools [][]string
	sys   []string
}

// script：第 n 次 AgentStream 调用执行的脚本
func newNomiHarness(t *testing.T, script func(ctx context.Context, n int, h *nomiHarness, emit func(blm.ChatChunk)) error) *nomiHarness {
	h := &nomiHarness{}
	calls := 0
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(ctx context.Context, msgs []blm.ChatMessage, tools []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			h.mu.Lock()
			n := calls
			calls++
			h.tools = append(h.tools, tools)
			h.sys = append(h.sys, msgs[0].Content)
			h.mu.Unlock()
			return script(ctx, n, h, emit)
		},
		WithBackground: func(ctx context.Context, level int, ask func(tool, summary, detail string) bool, _ []ConnectionGrant, _, _ bool, _ connections.ExternalJournal) context.Context {
			h.mu.Lock()
			h.asks = append(h.asks, ask)
			h.mu.Unlock()
			return ctx
		},
		Ready:  func() bool { return true },
		CostOf: func(_ string, in, out int64) (float64, bool) { return float64(in+out) / 1e6, true },
	})
	var ids int
	var idMu sync.Mutex
	h.rt = NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"nomi": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { idMu.Lock(); defer idMu.Unlock(); ids++; return fmt.Sprintf("%s_%d", p, ids) },
		Log:   &nopLog{}})
	h.rt.Start()
	return h
}

func (h *nomiHarness) ask() func(tool, s, d string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.asks[len(h.asks)-1]
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timeout")
}

func status(h *nomiHarness, id string) string { return h.rt.Get(id).Task.Status }

func nomiTask(h *nomiHarness, tools []string, level int, b *BudgetInput) string {
	return h.rt.Create(CreateInput{Title: "看 CI", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools}, Grant: Grant{Level: level}, Budget: b}).ID
}

func TestNomiExecutorCompletes(t *testing.T) {
	h := newNomiHarness(t, func(_ context.Context, _ int, _ *nomiHarness, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "tool_call.result", Name: sp("fs_read_text"), Output: sp("hello")})
		emit(blm.ChatChunk{Type: "delta", Content: "CI 是绿的。"})
		emit(blm.ChatChunk{Type: "usage", Usage: &blm.ChatUsage{PromptTokens: 100, CompletionTokens: 20}, Model: sp("m")})
		emit(blm.ChatChunk{Type: "usage", Usage: &blm.ChatUsage{PromptTokens: 300, CompletionTokens: 50}, Model: sp("m")})
		emit(blm.ChatChunk{Type: "done", FinishReason: "stop"})
		return nil
	})
	id := nomiTask(h, []string{"read", "web"}, 1, nil)
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return status(h, id) == StatusDone })
	rec := h.rt.Get(id)
	if rec.Attempts[0].Result.Summary != "CI 是绿的。" || rec.Attempts[0].Usage.InputTokens != 300 || rec.Attempts[0].Usage.OutputTokens != 50 {
		t.Fatalf("%+v", rec.Attempts[0])
	}
	tools := strings.Join(h.tools[0], ",")
	if !strings.Contains(tools, "http_get_readonly") || strings.Contains(tools, "fs_write_text") {
		t.Fatal(tools)
	}
}

func TestNomiExecutorApprovalRoundTrip(t *testing.T) {
	got := make(chan bool, 1)
	h := newNomiHarness(t, func(_ context.Context, _ int, h *nomiHarness, emit func(blm.ChatChunk)) error {
		got <- h.ask()("workspace_run", "npm test", "medium")
		emit(blm.ChatChunk{Type: "delta", Content: "测试跑完了"})
		return nil
	})
	id := nomiTask(h, []string{"shell"}, 3, nil)
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return status(h, id) == StatusWaitingUser })
	w := h.rt.Get(id).Task.Wait
	if w == nil || w.RequestID == nil || !strings.Contains(*w.Detail, "npm test") {
		t.Fatalf("%+v", w)
	}
	h.rt.Command(id, Command{Type: "decide", RequestID: w.RequestID, Approve: true})
	if !<-got {
		t.Fatal("not approved")
	}
	waitFor(t, func() bool { return status(h, id) == StatusDone })
}

func TestNomiExecutorCancelWhileWaiting(t *testing.T) {
	got := make(chan bool, 1)
	h := newNomiHarness(t, func(ctx context.Context, _ int, h *nomiHarness, emit func(blm.ChatChunk)) error {
		got <- h.ask()("fs_write_text", "x", "")
		<-ctx.Done()
		return ctx.Err()
	})
	id := nomiTask(h, []string{"file_write"}, 2, nil)
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return status(h, id) == StatusWaitingUser })
	h.rt.Command(id, Command{Type: "cancel"})
	if <-got {
		t.Fatal("approved after cancel")
	}
	time.Sleep(20 * time.Millisecond)
	if status(h, id) != StatusCancelled {
		t.Fatal(status(h, id))
	}
}

// 用量很大也不暂停：不按 token 拦截任务，一直做到完
func TestNomiExecutorLargeUsageKeepsRunning(t *testing.T) {
	h := newNomiHarness(t, func(ctx context.Context, n int, _ *nomiHarness, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "usage", Usage: &blm.ChatUsage{PromptTokens: 50_000_000, CompletionTokens: 200_000}})
		emit(blm.ChatChunk{Type: "delta", Content: "全部完成"})
		return nil
	})
	id := nomiTask(h, []string{"read"}, 1, nil)
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return status(h, id) == StatusDone })
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sys) != 1 {
		t.Fatalf("%d runs, want 1", len(h.sys))
	}
}

func TestClassifyError(t *testing.T) {
	for msg, code := range map[string]string{"HTTP 429": "upstream_transient", "upstream 503": "upstream_transient",
		"read: connection reset by peer": "network", "invalid api key": "executor_failed"} {
		if got := ClassifyError(msg).Code; got != code {
			t.Fatalf("%s: %s", msg, got)
		}
	}
}

func TestBuildPromptEvents(t *testing.T) {
	ctx := AttemptContext{Task: Task{Title: "t", Goal: "g"}, Attempt: Attempt{Cause: AttemptCause{Kind: "event"}}}
	msgs := BuildPrompt(ctx, "", 0, []SourceEvent{{Key: "k", Summary: "新文件：a.txt", Payload: map[string]any{"file": "a.txt"}}})
	sys := msgs[0].Content
	if !strings.Contains(sys, "触发这次运行的事件（1 件") || !strings.Contains(sys, "1. 新文件：a.txt\n{\"file\":\"a.txt\"}") ||
		!strings.Contains(sys, "</events>") {
		t.Fatal(sys)
	}
	if EventsSection(nil) != "" || strings.Contains(BuildPrompt(ctx, "", 0, nil)[0].Content, "<events>") {
		t.Fatal("empty events should add nothing")
	}
}

// #239：用预设模型运行（旧数据里带着 model 的任务也一样），实际供应商与模型记进执行快照
func TestNomiExecutorRoutedModelSnapshot(t *testing.T) {
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(_ context.Context, _ []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			emit(blm.ChatChunk{Type: "delta", Content: "完成"})
			return nil
		},
		Ready: func() bool { return true },
		Route: func() (string, string) { return "p1", "routed-model" },
	})
	n := 0
	rt := NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"nomi": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
	rt.Start()
	tools := []string{"read"}
	id := rt.Create(CreateInput{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools, Model: sp("model-a")}, Grant: Grant{Level: 1}}).ID
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return rt.Get(id).Task.Status == StatusDone })
	rec := rt.Get(id)
	snap := rec.Attempts[len(rec.Attempts)-1].Snapshot
	if snap.ProviderID == nil || *snap.ProviderID != "p1" || snap.Model == nil || *snap.Model != "routed-model" {
		t.Fatalf("%+v", snap)
	}
}

// #232：后台登记读任务当前授权：运行中收窄 / 撤销立即反映
func TestNomiExecutorLiveGrant(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var live func() (Grant, bool)
	var rt *Runtime
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(ctx context.Context, _ []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			<-release
			emit(blm.ChatChunk{Type: "delta", Content: "ok"})
			return nil
		},
		WithBackground: func(ctx context.Context, _ int, _ func(string, string, string) bool, _ []ConnectionGrant, _, _ bool, _ connections.ExternalJournal) context.Context {
			return ctx
		},
		LiveTask: func(id string) *Task {
			if rec := rt.Get(id); rec != nil {
				t := rec.Task
				return &t
			}
			return nil
		},
		LiveGrant: func(_ context.Context, l func() (Grant, bool), _ bool, _ func([]ConnectionGrant) []ConnectionGrant) {
			mu.Lock()
			live = l
			mu.Unlock()
		},
		Ready: func() bool { return true },
	})
	n := 0
	rt = NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"nomi": exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
	rt.Start()
	tools := []string{"read", "file_write"}
	id := rt.Create(CreateInput{Title: "t", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools}, Grant: Grant{Level: 2, Paths: []string{"/a", "/b"}}}).ID
	rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return live != nil })
	mu.Lock()
	l := live
	mu.Unlock()
	if g, ok := l(); !ok || g.Level != 2 || len(g.Paths) != 2 {
		t.Fatalf("%+v %v", g, ok)
	}
	if r := rt.Command(id, Command{Type: "grant", Grant: &Grant{Level: 1, Paths: []string{"/a"}}}); !r.OK {
		t.Fatal(r)
	}
	if g, ok := l(); !ok || g.Level != 1 || len(g.Paths) != 1 {
		t.Fatalf("narrowing not live: %+v %v", g, ok)
	}
	rt.Command(id, Command{Type: "revoke"})
	if _, ok := l(); ok {
		t.Fatal("revoked grant still live")
	}
	close(release)
}
