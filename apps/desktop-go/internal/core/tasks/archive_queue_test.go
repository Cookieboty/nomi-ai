package tasks

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/schedule"
)

func TestDefaultAcceptanceMatrix(t *testing.T) {
	ex := &syncExec{fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}}
	rt := newTestRuntime(ex)
	rt.Start()
	defer rt.Stop()

	at := int64(1_800_000_060_000)
	text := "ping"
	cases := []struct {
		name string
		in   CreateInput
		want string
	}{
		{
			name: "delegate-defaults-auto",
			in: CreateInput{
				Title: "委派", Goal: "g", Trigger: Trigger{Kind: "manual"},
				Origin:   Origin{CreatedBy: "nomi", Via: ptr("delegate")},
				Executor: ExecutorSpec{Kind: "nomi"},
			},
			want: "auto",
		},
		{
			name: "handoff-defaults-auto",
			in: CreateInput{
				Title: "转后台", Goal: "g", Trigger: Trigger{Kind: "manual"},
				Origin:   Origin{CreatedBy: "user", Via: ptr("handoff")},
				Executor: ExecutorSpec{Kind: "nomi"},
			},
			want: "auto",
		},
		{
			name: "notify-defaults-auto",
			in: CreateInput{
				Title: "通知", Goal: "g", Trigger: Trigger{Kind: "schedule", At: &at},
				Executor: ExecutorSpec{Kind: "notify", Text: &text},
			},
			want: "auto",
		},
		{
			name: "manual-standalone-defaults-user",
			in: CreateInput{
				Title: "手动", Goal: "g", Trigger: Trigger{Kind: "manual"},
				Executor: ExecutorSpec{Kind: "nomi"},
			},
			want: "user",
		},
		{
			name: "recurring-schedule-defaults-user",
			in: CreateInput{
				Title: "日报", Goal: "g",
				Trigger:  Trigger{Kind: "schedule", At: &at, Repeat: &schedule.Repeat{Kind: "daily"}},
				Executor: ExecutorSpec{Kind: "nomi"},
			},
			want: "user",
		},
		{
			name: "explicit-override-kept",
			in: CreateInput{
				Title: "手动直通", Goal: "g", Trigger: Trigger{Kind: "manual"},
				Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto",
			},
			want: "auto",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rt.Create(tc.in)
			if got.Acceptance != tc.want {
				t.Fatalf("%s: acceptance = %q, want %q", tc.name, got.Acceptance, tc.want)
			}
		})
	}
}

func TestArchiveUnarchiveAckAndAutoArchive24h(t *testing.T) {
	var mu sync.Mutex
	now := int64(1_800_000_000_000)
	var ids atomic.Int64
	s := NewService(ServiceDeps{
		Root:     t.TempDir(),
		Log:      &nopLog{},
		Now:      func() int64 { mu.Lock(); defer mu.Unlock(); return now },
		SetTimer: func(func(), int64) func() { return func() {} },
		T:        func(k string, _ ...any) string { return k },
	})
	ex := &syncExec{fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}}
	s.RegisterExecutor("nomi", ex)
	s.Start()
	defer s.Stop()

	// 1. 对话发起的委派任务完成 & 失败都在 24h 后自动归档
	doneDelegate, err := s.CreateDelegated(DelegatedInput{
		Title: "委派成功", Goal: "g", ConversationID: ptr("conv-1"),
		Executor: ExecutorSpec{Kind: "nomi"}, Level: 2,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 2. 独立一次性失败任务：未确认前不自动归档，也留在 Inbox
	s.RegisterExecutor("nomi", &syncFailExec{})
	failStandalone, err := s.Create(CreateRequest{
		Title: "独立失败", Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi"},
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.Command(failStandalone.ID, Command{Type: "runNow"})

	// 3. 对话委派失败任务：已回传对话，不进看板 Inbox，满 24h 自动归档
	failDelegate, err := s.CreateDelegated(DelegatedInput{
		Title: "委派失败", Goal: "g", ConversationID: ptr("conv-1"),
		Executor: ExecutorSpec{Kind: "nomi"}, Level: 2,
	})
	if err != nil {
		t.Fatal(err)
	}

	// 4. 持续周期任务完成后不进入已归档
	s.RegisterExecutor("nomi", ex)
	at := now + 60_000
	recurring, err := s.Create(CreateRequest{
		Title: "周报", Goal: "g",
		Trigger:  Trigger{Kind: "schedule", At: &at, Repeat: &schedule.Repeat{Kind: "daily"}},
		Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto",
	}, "user")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.Command(recurring.ID, Command{Type: "runNow"})

	if got := s.Get(recurring.ID).Task; got.LastRunStatus == nil || *got.LastRunStatus != "succeeded" || got.LastRunAt == nil {
		t.Fatalf("recurring missing LastRunStatus/LastRunAt: %+v", got)
	}

	inbox := s.Inbox()
	if len(inbox) != 1 || inbox[0].ID != failStandalone.ID {
		t.Fatalf("expected only standalone failure in inbox, got %+v", inbox)
	}

	// 推进 24 小时
	mu.Lock()
	now += AutoArchiveAfterMs + 1000
	mu.Unlock()
	s.Runtime.Tick()

	if tk := s.Get(doneDelegate.ID).Task; tk.ArchivedAt == nil || *tk.ArchiveReason != "auto_24h" {
		t.Fatalf("doneDelegate not auto archived: %+v", tk)
	}
	if tk := s.Get(failDelegate.ID).Task; tk.ArchivedAt == nil || *tk.ArchiveReason != "auto_24h" {
		t.Fatalf("failDelegate not auto archived: %+v", tk)
	}
	if tk := s.Get(failStandalone.ID).Task; tk.ArchivedAt != nil {
		t.Fatalf("unacked standalone failure must NOT auto archive: %+v", tk)
	}
	if tk := s.Get(recurring.ID).Task; tk.ArchivedAt != nil {
		t.Fatalf("recurring task must NOT auto archive: %+v", tk)
	}

	// 用户点「知道了」确认独立失败后，离开 Inbox；满下一个 24h 或手工归档可归档，也可一键归档所有已结束
	if res, err := s.Command(failStandalone.ID, Command{Type: "ack"}); err != nil || !res.OK {
		t.Fatalf("ack failed: %+v %v", res, err)
	}
	if len(s.Inbox()) != 0 {
		t.Fatalf("acked failure must leave inbox, got %+v", s.Inbox())
	}

	// 重新触发已归档任务会自动复活并清掉归档状态
	if res, err := s.Command(doneDelegate.ID, Command{Type: "unarchive"}); err != nil || !res.OK {
		t.Fatalf("unarchive failed: %+v %v", res, err)
	}
	if tk := s.Get(doneDelegate.ID).Task; tk.ArchivedAt != nil || tk.ArchiveReason != nil {
		t.Fatalf("unarchive did not clear fields: %+v", tk)
	}
	// 手动再归档，然后直接 follow_up 也应自动复活
	if res, err := s.Command(doneDelegate.ID, Command{Type: "archive"}); err != nil || !res.OK {
		t.Fatalf("archive failed: %+v %v", res, err)
	}
	if res := s.FollowUp(doneDelegate.ID, "继续分析"); !res.OK {
		t.Fatalf("followUp archived task failed: %+v", res)
	}
	if tk := s.Get(doneDelegate.ID).Task; tk.ArchivedAt != nil {
		t.Fatalf("followUp did not unarchive: %+v", tk)
	}

	// 一键归档所有已结束（包含已确认的 failStandalone，排除 ongoing doneDelegate 与周期 recurring）
	// 再造一个已完成未归档的普通任务确保 ArchiveAllEnded 计数正确
	n := ids.Add(1)
	extraDone, _ := s.Create(CreateRequest{
		Title: fmt.Sprintf("完成_%d", n), Goal: "g", Trigger: Trigger{Kind: "manual"},
		Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto",
	}, "user")
	_, _ = s.Command(extraDone.ID, Command{Type: "runNow"})

	archivedCount := s.ArchiveAllEnded()
	if archivedCount < 2 {
		t.Fatalf("expected at least 2 tasks archived by ArchiveAllEnded, got %d", archivedCount)
	}
	if s.Get(extraDone.ID).Task.ArchivedAt == nil || s.Get(failStandalone.ID).Task.ArchivedAt == nil {
		t.Fatal("ArchiveAllEnded missed ended tasks")
	}
	if s.Get(recurring.ID).Task.ArchivedAt != nil {
		t.Fatal("ArchiveAllEnded must skip enabled recurring tasks")
	}

	// Remove 允许删除已归档任务
	if !s.Remove(extraDone.ID) {
		t.Fatal("expected Remove on archived task to succeed")
	}
}

func TestQueueSnapshotReasonsAndPositions(t *testing.T) {
	var mu sync.Mutex
	now := int64(1_800_000_000_000)
	var ids atomic.Int64
	hold := ""
	ex := &fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}
	rt := NewRuntime(RuntimeDeps{
		Store:            newMemStoreSafe(),
		Executors:        map[string]Executor{"nomi": ex},
		Now:              func() int64 { mu.Lock(); defer mu.Unlock(); return now },
		SetTimer:         func(func(), int64) func() { return func() {} },
		NewID:            func(p string) string { return fmt.Sprintf("%s_%d", p, ids.Add(1)) },
		Log:              &nopLog{},
		MaxConcurrent:    1,
		MaxStartsPerHour: 100,
	})
	rt.SetHoldReason(func() string { return hold })
	rt.Start()
	defer rt.Stop()

	// 任务 1 占住并发槽位
	t1 := rt.Create(CreateInput{Title: "t1", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto"}).ID
	rt.Command(t1, Command{Type: "runNow"})

	// 任务 2、3 因 slot 排队
	t2 := rt.Create(CreateInput{Title: "t2", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto"}).ID
	t3 := rt.Create(CreateInput{Title: "t3", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}, Acceptance: "auto"}).ID
	rt.Command(t2, Command{Type: "runNow"})
	rt.Command(t3, Command{Type: "runNow"})

	snap := rt.QueueSnapshot()
	if snap[t2].Reason != "slot" || snap[t2].Position != 1 || snap[t2].ActiveCount != 1 || snap[t2].MaxConcurrent != 1 {
		t.Fatalf("unexpected slot queue info for t2: %+v", snap[t2])
	}
	if snap[t3].Reason != "slot" || snap[t3].Position != 2 {
		t.Fatalf("unexpected slot queue info for t3: %+v", snap[t3])
	}

	// holdReason 切换为 memory / cpu 时优先级反映到队列信息中
	hold = "memory"
	snap = rt.QueueSnapshot()
	if snap[t2].Reason != "memory" {
		t.Fatalf("expected hold reason memory, got %+v", snap[t2])
	}
	hold = "cpu"
	snap = rt.QueueSnapshot()
	if snap[t2].Reason != "cpu" {
		t.Fatalf("expected hold reason cpu, got %+v", snap[t2])
	}
	hold = ""

	// 放开槽位验证 retry 与 NotBefore 原因
	rt.Command(t1, Command{Type: "cancel"})
	// 模拟任务 2 退避重试
	ex.reporters[t2].Failed(TaskError{Code: "network", Message: "offline"})
	snap = rt.QueueSnapshot()
	// t3 已经拿走唯一槽位在跑，t2 等待退避重试
	if snap[t2].Reason != "retry" || snap[t2].RetryAt == nil {
		t.Fatalf("expected retry reason with RetryAt for t2, got %+v", snap[t2])
	}
}
