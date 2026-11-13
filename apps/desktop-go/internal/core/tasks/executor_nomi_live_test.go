package tasks

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
)

// 子任务侧栏：实时事件、写到一半的快照、插话与追问（docs/design/subagent-chat-parity.md）
type liveHarness struct {
	rt     *Runtime
	exec   Executor
	mu     sync.Mutex
	events []map[string]any
	reqIDs []string
	steers []string
	sys    []string
	traces []map[string]any
}

func newLiveHarness(t *testing.T, script func(ctx context.Context, n int, emit func(blm.ChatChunk)) error) *liveHarness {
	h := &liveHarness{}
	calls := 0
	h.exec = NewNomiExecutor(NomiDeps{
		AgentStream: func(ctx context.Context, msgs []blm.ChatMessage, _ []string, extra map[string]any, emit func(blm.ChatChunk)) error {
			h.mu.Lock()
			n := calls
			calls++
			h.reqIDs = append(h.reqIDs, fmt.Sprint(extra["reqId"]))
			h.sys = append(h.sys, msgs[0].Content)
			h.mu.Unlock()
			return script(ctx, n, emit)
		},
		Ready: func() bool { return true },
		Steer: func(reqID, text string) bool {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.steers = append(h.steers, reqID+"|"+text)
			return true
		},
		Live: func(_, _ string, ev map[string]any) {
			h.mu.Lock()
			h.events = append(h.events, ev)
			h.mu.Unlock()
		},
		Trace: func(_, _ string, line map[string]any) {
			h.mu.Lock()
			h.traces = append(h.traces, line)
			h.mu.Unlock()
		},
	})
	var ids int
	var idMu sync.Mutex
	h.rt = NewRuntime(RuntimeDeps{Store: newMemStoreSafe(), Executors: map[string]Executor{"nomi": h.exec},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { idMu.Lock(); defer idMu.Unlock(); ids++; return fmt.Sprintf("%s_%d", p, ids) },
		Log:   &nopLog{}})
	h.rt.Start()
	return h
}

func (h *liveHarness) task() string {
	tools := []string{"read"}
	return h.rt.Create(CreateInput{Title: "整理", Goal: "整理文档", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi", Tools: &tools}, Grant: Grant{Level: 1}}).ID
}

func TestNomiLiveEventsAndSnapshot(t *testing.T) {
	gate := make(chan struct{})
	h := newLiveHarness(t, func(_ context.Context, _ int, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "delta", Content: "先看看"})
		emit(blm.ChatChunk{Type: "tool_call.delta", ID: sp("c1"), Name: sp("fs_read_text"), ArgumentsJSON: sp(`{"path":"a.md"}`)})
		<-gate
		emit(blm.ChatChunk{Type: "tool_call.result", ID: sp("c1"), Name: sp("fs_read_text"), Output: sp("内容")})
		emit(blm.ChatChunk{Type: "delta", Content: "，做完了。"})
		return nil
	})
	id := h.task()
	h.rt.Command(id, Command{Type: "runNow"})
	lv := h.exec.(interface {
		LiveView(string) map[string]any
	})
	waitFor(t, func() bool {
		v := lv.LiveView(id)
		return v != nil && len(v["tools"].([]liveTool)) == 1
	})
	v := lv.LiveView(id)
	if v["text"] != "先看看" || v["tools"].([]liveTool)[0].Name != "fs_read_text" || v["tools"].([]liveTool)[0].TextAt != 3 {
		t.Fatalf("%+v", v)
	}
	close(gate)
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	if lv.LiveView(id) != nil {
		t.Fatal("snapshot kept after the run")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	kinds := []string{}
	for _, e := range h.events {
		k := fmt.Sprint(e["type"])
		if s, ok := e["status"]; ok {
			k += ":" + fmt.Sprint(s)
		}
		kinds = append(kinds, k)
	}
	if got := strings.Join(kinds, ","); got != "delta,tool:start,tool:done,delta,done" {
		t.Fatal(got)
	}
	// 轨迹里的工具行带上 id、参数和它在正文里的位置
	var toolLine map[string]any
	for _, l := range h.traces {
		if l["tool"] != nil {
			toolLine = l
		}
	}
	if toolLine["id"] != "c1" || toolLine["textAt"] != 3 || !strings.Contains(fmt.Sprint(toolLine["input"]), "a.md") {
		t.Fatalf("%+v", toolLine)
	}
	if !strings.HasPrefix(h.reqIDs[0], "task-") {
		t.Fatal(h.reqIDs)
	}
}

func TestNomiSteerGoesToRunningLoop(t *testing.T) {
	gate := make(chan struct{})
	h := newLiveHarness(t, func(_ context.Context, _ int, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "delta", Content: "在做"})
		<-gate
		emit(blm.ChatChunk{Type: "delta", Content: "好了"})
		return nil
	})
	st := h.exec.(interface{ Steer(string, string) bool })
	if st.Steer("nope", "x") {
		t.Fatal("steered a task that is not running")
	}
	id := h.task()
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusRunning })
	waitFor(t, func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.events) > 0 })
	if !st.Steer(id, "  顺便改标题  ") {
		t.Fatal("steer refused")
	}
	close(gate)
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.steers) != 1 || h.steers[0] != h.reqIDs[0]+"|顺便改标题" {
		t.Fatal(h.steers)
	}
	found := false
	for _, l := range h.traces {
		if l["user"] == "顺便改标题" && l["textAt"] == 2 {
			found = true
		}
	}
	if !found {
		t.Fatalf("%+v", h.traces)
	}
}

func TestNomiFollowUpRerunsWithPreviousResult(t *testing.T) {
	h := newLiveHarness(t, func(_ context.Context, n int, emit func(blm.ChatChunk)) error {
		emit(blm.ChatChunk{Type: "delta", Content: fmt.Sprintf("第 %d 次的结论", n+1)})
		return nil
	})
	id := h.task()
	// 还没跑过、正在跑：不能追问
	if r := h.rt.Command(id, Command{Type: "follow_up", Feedback: ""}); r.OK {
		t.Fatal("empty follow-up accepted")
	}
	h.rt.Command(id, Command{Type: "runNow"})
	waitFor(t, func() bool { return h.rt.Get(id).Task.Status == StatusDone })
	if r := h.rt.Command(id, Command{Type: "follow_up", Feedback: "再加一节总结"}); !r.OK {
		t.Fatalf("%+v", r)
	}
	waitFor(t, func() bool { rec := h.rt.Get(id); return rec.Task.Status == StatusDone && len(rec.Attempts) == 2 })
	rec := h.rt.Get(id)
	a := rec.Attempts[1]
	if a.Cause.Kind != "followup" || a.Cause.Note == nil || *a.Cause.Note != "再加一节总结" || a.Result.Summary != "第 2 次的结论" {
		t.Fatalf("%+v", a)
	}
	h.mu.Lock()
	sys := h.sys[1]
	h.mu.Unlock()
	if !strings.Contains(sys, "再加一节总结") || !strings.Contains(sys, "第 1 次的结论") {
		t.Fatal(sys)
	}
}

func TestMachineFollowUpOnlyAfterTheRunEnded(t *testing.T) {
	base := Task{ID: "t", Status: StatusRunning, Enabled: true}
	if r := Transition(base, nil, Event{Type: "follow_up", Feedback: "x"}); r.OK || r.Reason != "busy" {
		t.Fatalf("%+v", r)
	}
	for _, s := range []string{StatusDone, StatusFailed, StatusCancelled, StatusIdle} {
		tk := base
		tk.Status = s
		r := Transition(tk, nil, Event{Type: "follow_up", Feedback: "x", At: 5})
		if !r.OK || r.Task.Status != StatusQueued || r.Task.Pending == nil || r.Task.Pending.Cause != "followup" || *r.Task.Pending.Note != "x" {
			t.Fatalf("%s: %+v", s, r)
		}
	}
	tk := base
	tk.Status, tk.Enabled = StatusDone, false
	if r := Transition(tk, nil, Event{Type: "follow_up", Feedback: "x"}); r.OK || r.Reason != "paused" {
		t.Fatalf("%+v", r)
	}
}

// 追问带的图片：状态机带进这次执行，执行时作为图片交给模型
func TestFollowUpImagesReachTheModel(t *testing.T) {
	tk := Task{ID: "t", Status: StatusDone, Enabled: true}
	r := Transition(tk, nil, Event{Type: "follow_up", Feedback: "看图", Images: []string{"/a.png"}, At: 5})
	if !r.OK || r.Task.Pending == nil || len(r.Task.Pending.Images) != 1 {
		t.Fatalf("%+v", r)
	}
	dir := t.TempDir()
	p := dir + "/1-0.jpg"
	if err := os.WriteFile(p, []byte{0xff, 0xd8, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := AttemptContext{Task: Task{Goal: "g"}, Attempt: Attempt{Cause: AttemptCause{Kind: "followup", Note: ptr("看图"), Images: []string{p, dir + "/missing.png"}}}}
	msgs := BuildPrompt(ctx, "", 0, nil)
	im := msgs[len(msgs)-1].Images
	if len(im) != 1 || im[0].Mime != "image/jpeg" || im[0].Data != "/9j/" {
		t.Fatalf("%+v", im)
	}
}
