package airouter

import (
	"testing"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestBatcherMergesAndPreservesOrder(t *testing.T) {
	var got []string
	b := newBatcher(time.Hour, func(o *u.Obj) { got = append(got, u.Stringify(o)) })
	b.push(u.NewObj("type", "delta", "content", "a"))
	b.push(u.NewObj("type", "delta", "content", "b"))
	b.push(u.NewObj("type", "reasoning", "content", "r"))
	b.push(u.NewObj("type", "delta", "content", "c", "extra", 1))
	b.push(u.NewObj("type", "delta", "content", "d"))
	b.finish()
	want := []string{
		`{"type":"delta","content":"ab"}`,
		`{"type":"reasoning","content":"r"}`,
		`{"type":"delta","content":"c","extra":1}`,
		`{"type":"delta","content":"d"}`,
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: got %s want %s", i, got[i], want[i])
		}
	}
}

func TestBatcherTimerFlush(t *testing.T) {
	ch := make(chan string, 4)
	b := newBatcher(5*time.Millisecond, func(o *u.Obj) { ch <- u.Stringify(o) })
	b.push(u.NewObj("type", "delta", "content", "x"))
	select {
	case s := <-ch:
		if s != `{"type":"delta","content":"x"}` {
			t.Fatal(s)
		}
	case <-time.After(time.Second):
		t.Fatal("timer did not flush")
	}
	b.stop()
}
