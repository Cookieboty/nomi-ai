package airouter

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/paritytest"
)

// 假时钟：定时器按（到期时间, 创建顺序）触发，与 node:test mock timers 一致
type fakeClock struct {
	now    time.Duration
	seq    int
	timers []*fakeTimer
}

type fakeTimer struct {
	due     time.Duration
	seq     int
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { was := !t.stopped; t.stopped = true; return was }

func (c *fakeClock) AfterFunc(d time.Duration, f func()) stopper {
	c.seq++
	t := &fakeTimer{due: c.now + d, seq: c.seq, f: f}
	c.timers = append(c.timers, t)
	return t
}

// advance：前进 1ms，依次触发到期定时器（回调里新建的到期定时器同轮触发）
func (c *fakeClock) advance(d time.Duration) {
	c.now += d
	for {
		live := c.timers[:0]
		for _, t := range c.timers {
			if !t.stopped {
				live = append(live, t)
			}
		}
		c.timers = live
		sort.SliceStable(c.timers, func(i, j int) bool {
			if c.timers[i].due != c.timers[j].due {
				return c.timers[i].due < c.timers[j].due
			}
			return c.timers[i].seq < c.timers[j].seq
		})
		if len(c.timers) == 0 || c.timers[0].due > c.now {
			return
		}
		t := c.timers[0]
		t.stopped = true
		t.f()
	}
}

type batchSpec struct {
	Ms        int `json:"ms"`
	Scenarios []struct {
		Name   string               `json:"name"`
		Events [][2]json.RawMessage `json:"events"`
	} `json:"scenarios"`
}

func runBatch(t *testing.T, ms int, events [][2]json.RawMessage, mutate func(*batcher)) (emitted []any, outcome map[string]any) {
	clk := &fakeClock{}
	emitted = []any{}
	b := newBatcher(time.Duration(ms)*time.Millisecond, func(c *u.Obj) {
		var v any
		raw, _ := json.Marshal(c)
		_ = json.Unmarshal(raw, &v)
		emitted = append(emitted, map[string]any{"at": float64(clk.now / time.Millisecond), "chunk": v})
	})
	b.clock = clk
	if mutate != nil {
		mutate(b)
	}
	// 源：每个事件在其虚拟时刻经同一时钟的定时器送达（与 Node 源里的 setTimeout 睡眠对应）
	var step func(i int)
	deliver := func(i int) {
		var ev any
		_ = json.Unmarshal(events[i][1], &ev)
		switch ev {
		case "done":
			b.finish()
			outcome = map[string]any{"at": float64(clk.now / time.Millisecond), "end": "done"}
			return
		case "error":
			b.stop()
			outcome = map[string]any{"at": float64(clk.now / time.Millisecond), "end": "error", "message": "boom"}
			return
		}
		o := u.NewObj()
		if err := json.Unmarshal(events[i][1], o); err != nil {
			t.Fatal(err)
		}
		b.push(o)
		step(i + 1)
	}
	step = func(i int) {
		var at int
		_ = json.Unmarshal(events[i][0], &at)
		wait := time.Duration(at)*time.Millisecond - clk.now
		if wait > 0 {
			clk.AfterFunc(wait, func() { deliver(i) })
			return
		}
		deliver(i)
	}
	step(0)
	for i := 0; i < 10000 && outcome == nil; i++ {
		clk.advance(time.Millisecond)
	}
	return emitted, outcome
}

func loadBatch(t *testing.T) (batchSpec, []map[string]any) {
	var spec batchSpec
	b, err := os.ReadFile(paritytest.RepoPath("scripts/parity/b5-batch-scenarios.json"))
	if err != nil {
		paritytest.SkipOrFail(t, "scenarios:", err)
	}
	if err := json.Unmarshal(b, &spec); err != nil {
		t.Fatal(err)
	}
	p, _ := paritytest.Golden(t, "b5_batch.json", "testdata/b5_batch.json")
	gb, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var want []map[string]any
	if err := json.Unmarshal(gb, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(spec.Scenarios) {
		t.Fatalf("golden %d vs scenarios %d", len(want), len(spec.Scenarios))
	}
	return spec, want
}

func batchResult(name string, em []any, oc map[string]any) map[string]any {
	raw, _ := json.Marshal(map[string]any{"name": name, "emitted": em, "outcome": oc})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return m
}

// batchTextChunks 的输出序列与时刻和 Node（fake timers）一致
func TestBatchParity(t *testing.T) {
	spec, want := loadBatch(t)
	for i, sc := range spec.Scenarios {
		em, oc := runBatch(t, spec.Ms, sc.Events, nil)
		if got := batchResult(sc.Name, em, oc); !reflect.DeepEqual(got, want[i]) {
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(want[i])
			t.Errorf("%s:\n got %s\nwant %s", sc.Name, g, w)
		}
	}
}

func TestBatchParityMutation(t *testing.T) {
	spec, want := loadBatch(t)
	muts := map[string]func(*batcher){
		"window+1ms": func(b *batcher) { b.ms += time.Millisecond },
		"window-1ms": func(b *batcher) { b.ms -= time.Millisecond },
		"content-altered": func(b *batcher) {
			out := b.out
			b.out = func(c *u.Obj) { c.Set("content", "!"); out(c) }
		},
	}
	for name, m := range muts {
		caught := false
		for i, sc := range spec.Scenarios {
			em, oc := runBatch(t, spec.Ms, sc.Events, m)
			if !reflect.DeepEqual(batchResult(sc.Name, em, oc), want[i]) {
				caught = true
				break
			}
		}
		if !caught {
			t.Errorf("mutation %s not caught", name)
		}
	}
}
