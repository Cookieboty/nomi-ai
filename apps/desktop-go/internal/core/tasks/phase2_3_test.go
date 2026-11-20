package tasks

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	blm "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/llm"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

type steerCliHarness struct {
	*fakeCli
	mu     sync.Mutex
	steers []string
}

func (s *steerCliHarness) SteerTab(id, text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.steers = append(s.steers, id+"|"+text)
	return true
}

func TestCliSteerAndFollowUpPrompts(t *testing.T) {
	f := &steerCliHarness{fakeCli: newFakeCli(map[string]bool{"claude": true})}
	var ids atomic.Int64
	s := NewService(ServiceDeps{
		Root:     t.TempDir(),
		Log:      &nopLog{},
		Now:      func() int64 { return 1_800_000_000_000 },
		SetTimer: func(func(), int64) func() { return func() {} },
		T:        func(k string, _ ...any) string { return k },
	})
	ex := NewCliExecutor(CliDeps{
		Harness:     f,
		GitChanged:  func(string) []string { return nil },
		BuildPrompt: func(goal, ctx, doneWhen, _ string) string { return goal + "\n" + ctx + "\n" + doneWhen },
		ParseReport: func(s string) *CliReport { return &CliReport{Done: s} },
		DirOk:       func(string) bool { return true },
	})
	s.RegisterExecutor("cli", ex)
	s.Start()
	defer s.Stop()

	task, err := s.Create(CreateRequest{
		Title: "修测试", Goal: "修好 test", Trigger: Trigger{Kind: "manual"},
		Executor:   ExecutorSpec{Kind: "cli", Cli: ptr("claude"), Cwd: ptr("/repo"), Isolation: ptr("shared")},
		Grant:      Grant{Level: 2, Paths: []string{"/repo"}},
		Acceptance: "auto",
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	id := task.ID
	if res, err := s.Command(id, Command{Type: "runNow"}); err != nil || !res.OK {
		t.Fatal(res, err)
	}
	waitFor(t, func() bool { return f.sendCount() == 1 })
	if !s.Steer(id, "顺便加上单测") {
		t.Fatal("expected CLI Steer to return true")
	}
	f.mu.Lock()
	if len(f.steers) != 1 || !strings.Contains(f.steers[0], "顺便加上单测") {
		t.Fatalf("unexpected steer calls: %+v", f.steers)
	}
	f.mu.Unlock()
	f.finish("第一轮完成")
	waitFor(t, func() bool { return s.Get(id).Task.Status == StatusDone })

	// CLI 支持 FollowUp（reused == true）
	if res := s.FollowUp(id, "顺带修一下 lint"); !res.OK {
		t.Fatalf("CLI followUp failed: %+v", res)
	}
	waitFor(t, func() bool { return f.sendCount() == 2 })
	f.fakeCli.mu.Lock()
	secondPrompt := f.sends[1]
	f.fakeCli.mu.Unlock()
	if !strings.Contains(secondPrompt, "顺带修一下 lint") {
		t.Fatalf("reused CLI prompt missing follow-up text:\n%s", secondPrompt)
	}
	f.finish("第二轮完成")
	waitFor(t, func() bool { return s.Get(id).Task.Status == StatusDone })

	// 非 reused（测试 promptFor 在新建标签分支下也保留 PreviousSummary 和追问）
	_ = ids.Add(1)
	ce := ex.(*cliExecutor)
	freshPrompt := ce.promptFor(AttemptContext{
		Task: Task{Title: "t", Goal: "原始目标", Executor: ExecutorSpec{Kind: "cli"}},
		Attempt: Attempt{
			Cause: AttemptCause{
				Kind:     "followup",
				Note:     ptr("再加基准测试"),
				FollowUp: &FollowUpContext{Text: "再加基准测试", PreviousSummary: "第一轮完成了核心逻辑"},
			},
		},
	}, false)
	if !strings.Contains(freshPrompt, "第一轮完成了核心逻辑") || !strings.Contains(freshPrompt, "再加基准测试") {
		t.Fatalf("fresh CLI followUp prompt missing context:\n%s", freshPrompt)
	}
}

func TestAppendQueuedAndUpdateGoalAndPatch(t *testing.T) {
	var prompts []string
	var pmu sync.Mutex
	s := NewService(ServiceDeps{
		Root:     t.TempDir(),
		Log:      &nopLog{},
		Now:      func() int64 { return 1_800_000_000_000 },
		SetTimer: func(func(), int64) func() { return func() {} },
		T:        func(k string, _ ...any) string { return k },
	})
	gate := make(chan struct{})
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(_ context.Context, msgs []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			pmu.Lock()
			prompts = append(prompts, msgs[0].Content+"|"+msgs[1].Content)
			n := len(prompts)
			pmu.Unlock()
			if n == 1 {
				<-gate
			}
			emit(blm.ChatChunk{Type: "delta", Content: fmt.Sprintf("done_%d", n)})
			return nil
		},
		Ready: func() bool { return true },
	})
	s.RegisterExecutor("nomi", exec)
	s.Runtime.SetMaxConcurrent(1)
	s.Start()
	defer s.Stop()

	at := int64(1_800_000_060_000)
	t1, _ := s.Create(CreateRequest{
		Title: "占位", Goal: "hold", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto",
	}, "user")
	_, _ = s.Command(t1.ID, Command{Type: "runNow"})

	t2, _ := s.Create(CreateRequest{
		Title: "日报", Goal: "生成日报",
		Trigger:  Trigger{Kind: "schedule", At: &at, Repeat: &schedule.Repeat{Kind: "daily"}},
		Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto",
	}, "user")
	_, _ = s.Command(t2.ID, Command{Type: "runNow"})
	waitFor(t, func() bool { return s.Get(t2.ID).Task.Status == StatusQueued })

	// 对 queued 任务用 FollowUp 仍保持返回 busy，用 AppendQueued 才允许补充指令和图片
	if r := s.FollowUp(t2.ID, "conflict"); r.OK || r.Reason != "busy" {
		t.Fatalf("expected busy on FollowUp for queued, got %+v", r)
	}
	img := FollowUpImage{Mime: "image/png", Data: base64.StdEncoding.EncodeToString([]byte("img"))}
	if r := s.AppendQueued(t2.ID, "附上异常日志分析", img); !r.OK {
		t.Fatalf("AppendQueued failed: %+v", r)
	}
	if rec := s.Get(t2.ID); rec.Task.Pending == nil || rec.Task.Pending.Note == nil || *rec.Task.Pending.Note != "附上异常日志分析" {
		t.Fatalf("pending note not saved: %+v", rec.Task.Pending)
	}

	// Patch 更新 Goal / DoneWhen / Acceptance
	patched, err := s.Update(t2.ID, Patch{
		Goal:       ptr("生成日报（新目标）"),
		DoneWhen:   ptr("包含统计表格"),
		Acceptance: ptr("user"),
	})
	if err != nil || patched == nil || patched.Goal != "生成日报（新目标）" || patched.Acceptance != "user" ||
		patched.Executor.Brief == nil || patched.Executor.Brief.DoneWhen != "包含统计表格" {
		t.Fatalf("patch failed: %+v err=%v", patched, err)
	}

	// 放行排队任务并等待完成
	close(gate)
	waitFor(t, func() bool { return s.Get(t2.ID).Task.Status == StatusAwaitingAccept })
	_, _ = s.Command(t2.ID, Command{Type: "accept"})
	waitFor(t, func() bool { return s.Get(t2.ID).Task.Status == StatusIdle })

	// 对持续自动化任务选择同步更新长期目标进行 followUp
	if r := s.FollowUpWithOptions(t2.ID, "补充风险预测章节", true); !r.OK {
		t.Fatalf("FollowUpWithOptions failed: %+v", r)
	}
	updated := s.Get(t2.ID).Task
	if !strings.Contains(updated.Goal, "补充风险预测章节") {
		t.Fatalf("expected Goal to include updateGoal text, got %q", updated.Goal)
	}
	waitFor(t, func() bool {
		rec := s.Get(t2.ID)
		return len(rec.Attempts) == 2 && rec.Task.Status == StatusAwaitingAccept
	})
}

func TestCreateHandoffAndPrompt(t *testing.T) {
	var seen []string
	var smu sync.Mutex
	s := NewService(ServiceDeps{
		Root:     t.TempDir(),
		Log:      &nopLog{},
		Now:      func() int64 { return 1_800_000_000_000 },
		SetTimer: func(func(), int64) func() { return func() {} },
		T:        func(k string, _ ...any) string { return k },
	})
	exec := NewNomiExecutor(NomiDeps{
		AgentStream: func(_ context.Context, msgs []blm.ChatMessage, _ []string, _ map[string]any, emit func(blm.ChatChunk)) error {
			smu.Lock()
			seen = append(seen, msgs[0].Content)
			smu.Unlock()
			emit(blm.ChatChunk{Type: "delta", Content: "全部交接任务已完成"})
			return nil
		},
		Ready: func() bool { return true },
	})
	s.RegisterExecutor("nomi", exec)
	s.Start()
	defer s.Stop()

	task, err := s.CreateHandoff(HandoffInput{
		ConversationID:  "conv-abc",
		ProjectID:       "proj-1",
		UserGoal:        "梳理全仓模块依赖图并生成说明",
		PartialContent:  "已经扫描了 packages/ 下的目录结构...",
		ProgressSummary: "fs_list(packages)",
		Cwd:             "/repo",
		Paths:           []string{"/repo"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if task.Origin.Via == nil || *task.Origin.Via != "handoff" || task.Acceptance != "auto" ||
		task.Origin.ConversationID == nil || *task.Origin.ConversationID != "conv-abc" {
		t.Fatalf("unexpected handoff task metadata: %+v", task)
	}
	waitFor(t, func() bool { return s.Get(task.ID).Task.Status == StatusDone })
	smu.Lock()
	defer smu.Unlock()
	if len(seen) == 0 || !strings.Contains(seen[0], "接力任务") || !strings.Contains(seen[0], "已经扫描了 packages/") {
		t.Fatalf("handoff prompt missing handoff section or partial content:\n%v", seen)
	}
}
