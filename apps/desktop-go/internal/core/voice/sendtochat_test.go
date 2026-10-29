package voice

import (
	"sync"
	"testing"
	"time"
)

// D-B9-8：sendToChat 在页面加载中时等 did-finish-load，再 setTimeout(500)；已加载完则立即投递
func TestSendToChatWaitsForPageLoad(t *testing.T) {
	var mu sync.Mutex
	var got []time.Time
	var loaded func()
	loading := true
	s := NewService(Deps{Root: t.TempDir(),
		OpenChat: func() func(func()) {
			if !loading {
				return nil
			}
			return func(fn func()) { loaded = fn }
		},
		PublishChat: func(n string, p any) { mu.Lock(); got = append(got, time.Now()); mu.Unlock() },
	})
	s.SendToChat("  你好 ")
	time.Sleep(700 * time.Millisecond)
	mu.Lock()
	if len(got) != 0 {
		t.Fatal("delivered before page load")
	}
	mu.Unlock()
	at := time.Now()
	loaded()
	time.Sleep(400 * time.Millisecond)
	mu.Lock()
	if len(got) != 0 {
		t.Fatal("delivered before +500ms")
	}
	mu.Unlock()
	time.Sleep(250 * time.Millisecond)
	mu.Lock()
	if len(got) != 1 || got[0].Sub(at) < 500*time.Millisecond {
		t.Fatalf("got %v", got)
	}
	mu.Unlock()
	loading = false
	s.SendToChat("x")
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatal("not delivered immediately when loaded")
	}
}
