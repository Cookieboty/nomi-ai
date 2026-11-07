package delegate

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestWaitMemory(t *testing.T) {
	old := MemoryWaitPoll
	MemoryWaitPoll = 5 * time.Millisecond
	defer func() { MemoryWaitPoll = old }()

	var critical atomic.Bool
	s := &Service{d: Deps{MemoryCritical: critical.Load}}
	if err := s.waitMemory(context.Background(), false); err != nil {
		t.Fatalf("not critical: %v", err)
	}

	critical.Store(true)
	var de *DelegateError
	if err := s.waitMemory(context.Background(), false); !errors.As(err, &de) || de.Code != "memory_pressure" {
		t.Fatalf("foreground under pressure = %v, want memory_pressure", err)
	}

	// 后台：等到缓解
	go func() { time.Sleep(30 * time.Millisecond); critical.Store(false) }()
	if err := s.waitMemory(context.Background(), true); err != nil {
		t.Fatalf("background wait = %v", err)
	}

	// 后台：等的时候被取消
	critical.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if err := s.waitMemory(ctx, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait = %v", err)
	}

	if err := (&Service{}).waitMemory(context.Background(), false); err != nil {
		t.Fatal("no MemoryCritical: never blocks")
	}
}
