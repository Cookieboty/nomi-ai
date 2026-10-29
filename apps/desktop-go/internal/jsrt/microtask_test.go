package jsrt

import (
	"strings"
	"testing"
	"time"
)

// Node: sync → microtasks (FIFO, 嵌套追加的也在本轮) → 下一个宏任务。
func TestMicrotaskOrder(t *testing.T) {
	var log []string
	done := make(chan struct{})
	Run(func() {
		SetTimeout(0, func() { log = append(log, "timeout"); close(done) })
		QueueMicrotask(func() {
			log = append(log, "m1")
			QueueMicrotask(func() { log = append(log, "m3") })
		})
		QueueMicrotask(func() { log = append(log, "m2") })
		log = append(log, "sync")
	})
	<-done
	if got := strings.Join(log, ","); got != "sync,m1,m2,m3,timeout" {
		t.Fatalf("order %s", got)
	}
}

// await 让出到事件循环前先跑完微任务。
func TestMicrotaskBeforeAwaitYield(t *testing.T) {
	var log []string
	p := NewPromise[int]()
	fin := make(chan struct{})
	go Run(func() {
		QueueMicrotask(func() { log = append(log, "micro") })
		Async(func() (int, error) {
			log = append(log, "a-sync")
			_, _ = Await(p)
			log = append(log, "a-resumed")
			close(fin)
			return 0, nil
		})
		log = append(log, "caller")
	})
	time.Sleep(20 * time.Millisecond)
	Run(func() { log = append(log, "other"); p.Resolve(1) })
	<-fin
	Run(func() {})
	if got := strings.Join(log, ","); got != "a-sync,caller,micro,other,a-resumed" {
		t.Fatalf("order %s", got)
	}
}

func TestAbortReason(t *testing.T) {
	Run(func() {
		c := NewAbortController()
		c.Abort()
		if _, ok := c.Signal.Reason().(AbortError); !ok {
			t.Fatal("default reason")
		}
		c2 := NewAbortController()
		var seen any
		c2.Signal.OnAbort(func() { seen = c2.Signal.Reason() })
		c2.AbortWith("why")
		c2.AbortWith("again")
		if seen != "why" || c2.Signal.Reason() != "why" {
			t.Fatalf("reason %v", seen)
		}
	})
}

// 同时到期的定时器按创建序执行（Node 语义），与 goroutine 抢锁先后无关。
func TestTimerOrderSameDue(t *testing.T) {
	for round := 0; round < 50; round++ {
		var log []int
		done := make(chan struct{})
		Run(func() {
			for i := 0; i < 20; i++ {
				i := i
				SetTimeout(5*time.Millisecond, func() {
					log = append(log, i)
					if i == 19 {
						close(done)
					}
				})
			}
		})
		<-done
		for i, v := range log {
			if v != i {
				t.Fatalf("round %d order %v", round, log)
			}
		}
	}
}
