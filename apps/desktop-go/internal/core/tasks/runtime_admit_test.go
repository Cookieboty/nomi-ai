package tasks

import (
	"context"
	"sync/atomic"
	"testing"
)

// 内存守护的放行判断：不放行时留在队列里，放行后 Tick 就开始
func TestRuntimeAdmit(t *testing.T) {
	ex := &syncExec{fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}}
	rt := newTestRuntime(ex)
	var open atomic.Bool
	rt.SetAdmit(func(Task) bool { return open.Load() })
	rt.Start()
	id := rt.Create(CreateInput{Title: "t", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}}).ID
	if r := rt.Command(id, Command{Type: "runNow"}); !r.OK {
		t.Fatal(r)
	}
	if st := rt.Get(id).Task.Status; st != StatusQueued {
		t.Fatalf("held task status = %s, want queued", st)
	}
	open.Store(true)
	rt.Tick()
	if st := rt.Get(id).Task.Status; st != StatusDone {
		t.Fatalf("after release status = %s, want done", st)
	}
}

func TestRunTaskContext(t *testing.T) {
	ctx := WithRunTask(context.Background(), "task_1")
	if RunTaskFrom(ctx) != "task_1" || RunTaskFrom(context.Background()) != "" || RunTaskFrom(nil) != "" {
		t.Fatal("RunTaskFrom")
	}
	if WithRunTask(ctx, "") != ctx {
		t.Fatal("empty id leaves ctx alone")
	}
}
