package tasks

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 执行者在 Start 里同步回报完成（重入）
type syncExec struct{ fakeExec }

func (s *syncExec) Start(ctx AttemptContext) {
	s.fakeExec.Start(ctx)
	ctx.Report.Completed(AttemptResult{Summary: "sync", Artifacts: []Artifact{}})
}

// 执行者在别的 goroutine 里回报
type asyncExec struct {
	fakeExec
	wg *sync.WaitGroup
}

func (a *asyncExec) Start(ctx AttemptContext) {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		ctx.Report.Heartbeat()
		ctx.Report.Usage(UsageDelta{InputTokens: 10})
		ctx.Report.Completed(AttemptResult{Summary: "async", Artifacts: []Artifact{}})
	}()
}

func newTestRuntime(ex Executor) *Runtime {
	var ids atomic.Int64
	var mu sync.Mutex
	now := int64(1_800_000_000_000)
	return NewRuntime(RuntimeDeps{
		Store:         newMemStoreSafe(),
		Executors:     map[string]Executor{"nomi": ex},
		Now:           func() int64 { mu.Lock(); defer mu.Unlock(); return now },
		SetTimer:      func(fn func(), ms int64) func() { return func() {} },
		NewID:         func(p string) string { return fmt.Sprintf("%s_%d", p, ids.Add(1)) },
		Log:           &nopLog{},
		MaxConcurrent: 2,
	})
}

type memStoreSafe struct {
	mu sync.Mutex
	*memStore
}

func newMemStoreSafe() *memStoreSafe { return &memStoreSafe{memStore: newMemStore()} }
func (m *memStoreSafe) Save(r Record) (Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.memStore.Save(r)
}
func (m *memStoreSafe) Append(id string, e JournalEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.memStore.Append(id, e)
}

func TestRuntimeSyncReportInStart(t *testing.T) {
	ex := &syncExec{fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}}
	rt := newTestRuntime(ex)
	rt.Start()
	for i := 0; i < 5; i++ {
		id := rt.Create(CreateInput{Title: "t", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}}).ID
		if r := rt.Command(id, Command{Type: "runNow"}); !r.OK {
			t.Fatal(r)
		}
	}
	for _, task := range rt.List() {
		if task.Status != StatusDone {
			t.Fatalf("%s %s", task.ID, task.Status)
		}
	}
}

func TestRuntimeConcurrentReports(t *testing.T) {
	var wg sync.WaitGroup
	ex := &asyncExec{fakeExec{reporters: map[string]Reporter{}, prepErr: map[string]TaskError{}}, &wg}
	rt := newTestRuntime(ex)
	rt.Start()
	ids := []string{}
	for i := 0; i < 20; i++ {
		ids = append(ids, rt.Create(CreateInput{Title: "t", Trigger: Trigger{Kind: "manual"}, Executor: ExecutorSpec{Kind: "nomi"}}).ID)
	}
	var cwg sync.WaitGroup
	for _, id := range ids {
		cwg.Add(1)
		go func(id string) { defer cwg.Done(); rt.Command(id, Command{Type: "runNow"}) }(id)
	}
	cwg.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for {
		wg.Wait()
		done := 0
		for _, task := range rt.List() {
			if task.Status == StatusDone {
				done++
			}
		}
		if done == len(ids) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d/%d done", done, len(ids))
		}
		rt.Tick()
	}
}
