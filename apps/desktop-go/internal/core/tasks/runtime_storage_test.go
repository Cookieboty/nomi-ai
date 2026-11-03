package tasks

import (
	"errors"
	"fmt"
	"testing"
)

// failingStore：fail 为 true 时 Save 返回磁盘错误
type failingStore struct {
	*memStoreSafe
	fail bool
}

func (s *failingStore) Save(r Record) (Record, error) {
	if s.fail {
		return Record{}, errors.New("no space left on device")
	}
	return s.memStoreSafe.Save(r)
}

func newStorageRuntime() (*Runtime, *failingStore, *fakeExec) {
	ex := &fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}
	st := &failingStore{memStoreSafe: newMemStoreSafe()}
	n := 0
	rt := NewRuntime(RuntimeDeps{Store: st, Executors: map[string]Executor{"nomi": ex},
		Now: func() int64 { return 1_800_000_000_000 }, SetTimer: func(func(), int64) func() { return func() {} },
		NewID: func(p string) string { n++; return fmt.Sprintf("%s_%d", p, n) }, Log: &nopLog{}})
	rt.Start()
	return rt, st, ex
}

// #237：创建时快照写入失败 → 返回错误，任务不进列表
func TestRuntimeCreateSaveFailure(t *testing.T) {
	rt, st, _ := newStorageRuntime()
	st.fail = true
	_, err := rt.CreateChecked(CreateInput{Title: "t", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}})
	if !errors.Is(err, ErrStorage) {
		t.Fatalf("want ErrStorage, got %v", err)
	}
	if n := len(rt.List()); n != 0 {
		t.Fatalf("task listed after failed save: %d", n)
	}
}

// #237：状态转换落盘失败 → 命令失败、执行者没启动、内存仍是旧状态；恢复后正常
func TestRuntimeTransitionSaveFailureSkipsEffects(t *testing.T) {
	rt, st, ex := newStorageRuntime()
	task, err := rt.CreateChecked(CreateInput{Title: "t", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}})
	if err != nil {
		t.Fatal(err)
	}
	st.fail = true
	if r := rt.Command(task.ID, Command{Type: "runNow"}); r.OK {
		t.Fatal("runNow succeeded although the snapshot was not saved")
	}
	for _, c := range ex.calls {
		if c["op"] == "start" {
			t.Fatalf("executor started without a saved snapshot: %v", ex.calls)
		}
	}
	if got := rt.Get(task.ID).Task.Status; got != StatusIdle {
		t.Fatalf("status changed in memory: %s", got)
	}
	st.fail = false
	if r := rt.Command(task.ID, Command{Type: "runNow"}); !r.OK {
		t.Fatal(r)
	}
	starts := 0
	for _, c := range ex.calls {
		if c["op"] == "start" {
			starts++
		}
	}
	if starts != 1 {
		t.Fatalf("want exactly one start after recovery, got %d", starts)
	}
}
