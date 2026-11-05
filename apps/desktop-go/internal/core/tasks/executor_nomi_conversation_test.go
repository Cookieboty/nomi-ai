package tasks

// 对应 nomiExecutor.test.ts 的「nomi 执行者：派给 Nomi（对话的工具集）」（docs/features/scheduling-calendar.md）

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/connections"
)

type convHarness struct {
	rt      *Runtime
	mu      sync.Mutex
	tools   [][]string
	sys     []string
	extra   []map[string]any
	tainted []bool
	trusted []bool
	level   []int
	conns   [][]ConnectionGrant
}

func newConvHarness(t *testing.T, toolNames []string, script func(ctx context.Context, emit func(blm.ChatChunk)) error) *convHarness {
	t.Helper()
	h := &convHarness{}
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(ctx context.Context, msgs []blm.ChatMessage, tools []string, extra map[string]any, emit func(blm.ChatChunk)) error {
			h.mu.Lock()
			h.tools = append(h.tools, tools)
			h.sys = append(h.sys, msgs[0].Content)
			h.extra = append(h.extra, extra)
			h.mu.Unlock()
			return script(ctx, emit)
		},
		WithBackground: func(ctx context.Context, level int, _ func(tool, summary, detail string) bool, conns []ConnectionGrant, tainted, trusted bool, _ connections.ExternalJournal) context.Context {
			h.mu.Lock()
			h.tainted = append(h.tainted, tainted)
			h.trusted = append(h.trusted, trusted)
			h.level = append(h.level, level)
			h.conns = append(h.conns, conns)
			h.mu.Unlock()
			return ctx
		},
		Ready:     func() bool { return true },
		ToolNames: func() []string { return toolNames },
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

func conversationExecutor() ExecutorSpec {
	return ExecutorSpec{Kind: "nomi", Tools: &[]string{}, Toolset: sp("conversation"), Cwd: sp("/work/deck"),
		Brief: &Brief{DoneWhen: "PPT 写进工作区", Context: sp("10 页，蓝色调")}}
}

func TestNomiConversationToolsetExtraAndPrompt(t *testing.T) {
	h := newConvHarness(t, []string{"image_generate", "fs_write_text", "delegate_to_cli", "delegate_to_nomi",
		"task_propose", "desktop_request_scope", "avatar_emotion"},
		func(_ context.Context, emit func(blm.ChatChunk)) error {
			emit(blm.ChatChunk{Type: "delta", Content: "做好了：deck.pptx"})
			emit(blm.ChatChunk{Type: "done", FinishReason: "stop"})
			return nil
		})
	via := "delegate"
	id := h.rt.Create(CreateInput{Title: "做 PPT", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Origin:   Origin{CreatedBy: "nomi", CreatedAt: 1_800_000_000_000, Via: &via, ConversationID: sp("c1")},
		Executor: conversationExecutor(), Grant: Grant{Level: 3}}).ID
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	h.mu.Lock()
	defer h.mu.Unlock()
	if want := []string{"image_generate", "fs_write_text", "delegate_to_cli"}; !reflect.DeepEqual(h.tools[0], want) {
		t.Fatalf("tools %v", h.tools[0])
	}
	if h.extra[0]["conversationId"] != "c1" || h.extra[0]["cwd"] != "/work/deck" || h.extra[0]["taskId"] != id {
		t.Fatalf("extra %v", h.extra[0])
	}
	sys := h.sys[0]
	for _, s := range []string{"工作区：/work/deck", "完成标准：PPT 写进工作区", "10 页，蓝色调", "delegate_to_cli"} {
		if !strings.Contains(sys, s) {
			t.Fatalf("system 缺 %q:\n%s", s, sys)
		}
	}
	if h.tainted[0] {
		t.Fatal("手动派出的不该 tainted")
	}
}

// 高级权限：后台执行标为 trusted，已注册的 MCP 工具全部授权
func TestNomiConversationElevated(t *testing.T) {
	h := newConvHarness(t, []string{"fs_write_text", "mail__send", "mail__list", "notes__add"},
		func(_ context.Context, emit func(blm.ChatChunk)) error {
			emit(blm.ChatChunk{Type: "delta", Content: "ok"})
			return nil
		})
	id := h.rt.Create(CreateInput{Title: "x", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: conversationExecutor(), Grant: Grant{Level: 4, Paths: []string{"/work/deck"}}}).ID
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.trusted[0] || h.tainted[0] || h.level[0] != 4 {
		t.Fatalf("trusted %v tainted %v level %d", h.trusted[0], h.tainted[0], h.level[0])
	}
	want := []ConnectionGrant{
		{ConnectionID: "mcp:mail", Capabilities: []string{"mcp.read", "mcp.call"}, Resources: []string{"send", "list"}},
		{ConnectionID: "mcp:notes", Capabilities: []string{"mcp.read", "mcp.call"}, Resources: []string{"add"}},
	}
	if !reflect.DeepEqual(h.conns[0], want) {
		t.Fatalf("conns %+v", h.conns[0])
	}
}

// 按授权工具类的普通任务不是高级权限
func TestNomiPlainTaskNotElevated(t *testing.T) {
	h := newConvHarness(t, []string{"mail__send"}, func(_ context.Context, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "delta", Content: "ok"})
		return nil
	})
	id := h.rt.Create(CreateInput{Title: "x", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &[]string{"read"}}, Grant: Grant{Level: 2}}).ID
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.trusted[0] || len(h.conns[0]) != 0 {
		t.Fatalf("trusted %v conns %+v", h.trusted[0], h.conns[0])
	}
}

func TestToolsForTaskNonConversation(t *testing.T) {
	tools := []string{"read"}
	got := ToolsForTask(Task{Executor: ExecutorSpec{Kind: "nomi", Tools: &tools}}, []string{"image_generate"})
	if strings.Contains(strings.Join(got, ","), "image_generate") || !strings.Contains(strings.Join(got, ","), "fs_read_text") {
		t.Fatal(got)
	}
	if got := ToolsForTask(Task{Executor: ExecutorSpec{Kind: "cli"}}, []string{"x"}); len(got) != 0 {
		t.Fatal(got)
	}
}

// beatReporter：只数心跳
type beatReporter struct {
	beats     atomic.Int32
	completed chan AttemptResult
}

func (r *beatReporter) Heartbeat()                { r.beats.Add(1) }
func (r *beatReporter) Usage(UsageDelta)          {}
func (r *beatReporter) NeedsUser(EventWait)       {}
func (r *beatReporter) Completed(a AttemptResult) { r.completed <- a }
func (r *beatReporter) Failed(TaskError)          {}
func (r *beatReporter) TakenOver()                {}
func (r *beatReporter) Carrier(Carrier)           {}

func TestNomiConversationHeartbeatDuringToolCall(t *testing.T) {
	var tickMu sync.Mutex
	var tick func()
	var interval int64
	cancelled := make(chan struct{})
	inTool, afterResult, release, finish := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(_ context.Context, _ []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			emit(blm.ChatChunk{Type: "tool_call.delta", Index: 0, ID: sp("t1"), Name: sp("image_generate")})
			close(inTool)
			<-release
			emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("t1"), Name: sp("image_generate"), Output: sp("ok")})
			close(afterResult)
			<-finish
			emit(blm.ChatChunk{Type: "delta", Content: "6 张图都进了素材库"})
			return nil
		},
		Ready:     func() bool { return true },
		ToolNames: func() []string { return []string{"image_generate"} },
		Every: func(ms int64, fn func()) func() {
			tickMu.Lock()
			tick, interval = fn, ms
			tickMu.Unlock()
			return func() { close(cancelled) }
		},
	})
	rep := &beatReporter{completed: make(chan AttemptResult, 1)}
	task := Task{ID: "task_1", Title: "生图", Goal: "g", Executor: conversationExecutor(), Grant: Grant{Level: 3}}
	exec.Start(AttemptContext{Task: task, Attempt: Attempt{ID: "att_1", TaskID: "task_1", Gen: 1,
		Cause: AttemptCause{Kind: "manual"}}, Report: rep})
	<-inTool
	tickMu.Lock()
	fn, ms := tick, interval
	tickMu.Unlock()
	if ms != 60_000 {
		t.Fatalf("interval %d", ms)
	}
	base := rep.beats.Load()
	// 看守超时默认 5 分钟：走过 10 分钟，期间每分钟一跳
	for i := 0; i < 10; i++ {
		fn()
	}
	if got := rep.beats.Load() - base; got != 10 {
		t.Fatalf("工具调用期间心跳 %d 次，want 10", got)
	}
	close(release)
	<-afterResult
	base = rep.beats.Load()
	fn()
	fn()
	if got := rep.beats.Load() - base; got != 0 {
		t.Fatalf("工具返回后不该再补心跳：%d", got)
	}
	close(finish)
	if r := <-rep.completed; r.Summary != "6 张图都进了素材库" {
		t.Fatal(r.Summary)
	}
	<-cancelled
}
