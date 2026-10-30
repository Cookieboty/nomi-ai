package server

import (
	"strconv"
	"sync"
	"testing"
)

// #199：net/http 每个连接一个 goroutine，同 / 不同 session 的 Get / Set / Size 会并发打到同一个
// Affinity。没有锁时 `go test -race` 报竞态，运行期可能 concurrent map read and map write 直接 fatal。
func TestAffinityConcurrentAccess(t *testing.T) {
	a := NewAffinity(nil, 64, 0)
	const workers, rounds = 16, 500
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				// 一半写共享 session，一半写各自 session；容量 64 会不断触发淘汰。
				s := "shared"
				if i%2 == 1 {
					s = "s" + strconv.Itoa(w) + ":" + strconv.Itoa(i%100)
				}
				a.Set(s, AffinityTarget{ProviderID: "p" + strconv.Itoa(w), KeyID: "k"})
				if got := a.Get(s); got != nil && got.KeyID != "k" {
					t.Errorf("Get(%q) = %+v", s, got)
				}
				if n := a.Size(); n > 64 {
					t.Errorf("Size() = %d > max", n)
				}
			}
		}(w)
	}
	wg.Wait()
	if n := a.Size(); n != 64 {
		t.Fatalf("Size() = %d, want 64", n)
	}
}

// 加锁不改 LRU 语义：命中刷新顺序、容量淘汰最旧、TTL 过期即删。
func TestAffinityLRUSemantics(t *testing.T) {
	now := 0.0
	a := NewAffinity(func() float64 { return now }, 2, 1000)
	a.Set("a", AffinityTarget{"pa", "ka"})
	a.Set("b", AffinityTarget{"pb", "kb"})
	if a.Get("a") == nil { // a 变成最新
		t.Fatal("a missing")
	}
	a.Set("c", AffinityTarget{"pc", "kc"}) // 淘汰最旧的 b
	if a.Get("b") != nil || a.Get("a") == nil || a.Get("c") == nil {
		t.Fatal("eviction order changed")
	}
	now = 2001
	if a.Get("a") != nil {
		t.Fatal("expired entry returned")
	}
	if a.Size() != 1 {
		t.Fatalf("expired entry not dropped: size %d", a.Size())
	}
}
