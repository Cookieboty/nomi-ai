package delegate

import (
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 调度策略的上限是同步委派与持续任务合计：持续任务那边在跑的也占名额；名额空出来时通知那边
func TestSlotFreeCountsSharedLoad(t *testing.T) {
	SetMaxParallel(3)
	defer SetMaxParallel(0)
	s := &Service{tasks: map[string]*bgTask{}}
	other := 2
	s.SetSharedLoad(func() int { return other })
	freed := make(chan struct{}, 4)
	s.SetOnFreed(func() { freed <- struct{}{} })

	s.mu.Lock()
	if !s.slotFreeLocked() {
		t.Fatal("2 tasks + 0 delegates < 3")
	}
	s.setTask(&bgTask{o: util.NewObj("taskId", "a", "status", "running")})
	if s.slotFreeLocked() || s.Load() != 1 {
		t.Fatalf("2 tasks + 1 delegate = 3 is full (load %d)", s.Load())
	}
	s.tasks["a"].o.Set("status", "done")
	s.setTask(s.tasks["a"])
	s.mu.Unlock()
	if s.Load() != 0 {
		t.Fatal(s.Load())
	}
	select {
	case <-freed:
	case <-time.After(time.Second):
		t.Fatal("finishing a delegate should wake the task queue")
	}
	other = 3
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.slotFreeLocked() {
		t.Fatal("3 tasks fill the shared limit")
	}
}
