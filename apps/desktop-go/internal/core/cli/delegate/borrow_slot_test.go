package delegate

import (
	"context"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// 后台 Nomi 把共享上限占满、各自同步等子委派：子委派借父任务的名额，不去排队（#294）
func TestBackgroundParentsLendTheirSlots(t *testing.T) {
	SetMaxParallel(5)
	defer SetMaxParallel(0)
	s := &Service{tasks: map[string]*bgTask{}}
	s.SetSharedLoad(func() int { return 5 }) // 5 个后台 Nomi 父任务占满了
	var releases []func()
	for i := range 5 {
		ctx := desktop.WithBackground(context.Background(), &desktop.BackgroundRun{})
		done := make(chan struct{})
		go func() {
			defer close(done)
			rel, lent, err := s.slotFor(ctx, true)
			if err != nil || !lent {
				t.Errorf("child %d: lent=%v err=%v", i, lent, err)
				return
			}
			releases = append(releases, rel)
		}()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatalf("child %d is stuck waiting for a slot its parent holds", i)
		}
	}
	// 借来的子委派在跑：不另算名额，Load 不变
	s.mu.Lock()
	s.setTask(&bgTask{o: util.NewObj("taskId", "c", "status", "running"), lent: true})
	s.mu.Unlock()
	if s.Load() != 0 {
		t.Fatalf("a lent child counted again: load %d", s.Load())
	}
	for _, r := range releases {
		r()
		r()
	}
	if len(s.lending) != 0 {
		t.Fatalf("lending not cleared: %d", len(s.lending))
	}
	// 前台的照常排队：上限满了要等
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, lent, err := s.slotFor(ctx, true); err == nil || lent {
		t.Fatalf("a foreground delegation took a slot past the limit (lent=%v)", lent)
	}
}

// 同一个父任务同时只借给一个子委派：第二个等前一个还回来；这一轮被停时退出
func TestBorrowSlotOnePerParent(t *testing.T) {
	s := &Service{tasks: map[string]*bgTask{}}
	run := &desktop.BackgroundRun{}
	ctx := desktop.WithBackground(context.Background(), run)
	rel, err := s.borrowSlot(ctx, run)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan error, 1)
	go func() {
		r2, err := s.borrowSlot(ctx, run)
		if err == nil {
			r2()
		}
		got <- err
	}()
	select {
	case <-got:
		t.Fatal("a second child borrowed while the first still holds the slot")
	case <-time.After(50 * time.Millisecond):
	}
	rel()
	select {
	case err := <-got:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("the second child never got the slot back")
	}

	rel, _ = s.borrowSlot(ctx, run)
	defer rel()
	stop, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.borrowSlot(stop, run); err == nil {
		t.Fatal("a stopped turn should leave the wait")
	}
}
