package delegate

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

type steerLog struct {
	mu  sync.Mutex
	got map[string][]string
}

func (s *steerLog) fn(tab, text string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.got[tab] = append(s.got[tab], text)
	return true
}

func (s *steerLog) count(tab string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.got[tab])
}

func waitSteer(t *testing.T, s *steerLog, tab string, n int) {
	t.Helper()
	for i := 0; i < 100 && s.count(tab) < n; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	if s.count(tab) < n {
		t.Fatalf("%s: want %d steer(s), got %v", tab, n, s.got)
	}
}

// 同一个文件：优先级高的赢，后来的低优先级让路并收到插话；先来的低优先级碰上后来的高优先级也让路
func TestClaimsPriority(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &steerLog{got: map[string][]string{}}
	c := NewClaims()
	c.SetSteer(s.fn)
	c.Register("low", root, root, "low", "低")
	c.Register("high", root, root, "high", "高")
	c.Touch("low", []string{"a.go"})
	c.Touch("high", []string{filepath.Join(root, "a.go")})
	waitSteer(t, s, "low", 1)
	if !strings.Contains(s.got["low"][0], "「高」") || s.count("high") != 0 {
		t.Fatalf("the low-priority task should yield to 高: %v", s.got)
	}
	c.Touch("low", []string{"a.go"}) // 已让过，不再插话
	time.Sleep(20 * time.Millisecond)
	if s.count("low") != 1 {
		t.Fatalf("yield should be told once: %v", s.got)
	}
	mine, yielded := c.Finish("low").Filter([]string{"a.go", "b.go"})
	if strings.Join(mine, ",") != "b.go" || len(yielded) != 1 || !strings.HasPrefix(yielded[0], "a.go") {
		t.Fatalf("low: mine=%v yielded=%v", mine, yielded)
	}
	mine, yielded = c.Finish("high").Filter([]string{"a.go"})
	if strings.Join(mine, ",") != "a.go" || len(yielded) != 0 {
		t.Fatalf("high: mine=%v yielded=%v", mine, yielded)
	}
}

// 同级：先来的优先；别人同期改的文件不算进自己的改动
func TestClaimsSameRankAndForeign(t *testing.T) {
	root := t.TempDir()
	s := &steerLog{got: map[string][]string{}}
	c := NewClaims()
	c.SetSteer(s.fn)
	c.Register("a", root, root, "", "A")
	c.Register("b", root, root, "medium", "B")
	c.Touch("a", []string{"x.go"})
	c.Touch("b", []string{"x.go", "y.go"})
	waitSteer(t, s, "b", 1)
	// a 先结束：b 改的 y.go 不算 a 的
	mine, _ := c.Finish("a").Filter([]string{"x.go", "y.go"})
	if strings.Join(mine, ",") != "x.go" {
		t.Fatalf("a: %v", mine)
	}
	// b 后结束：a 改的 x.go 让给了 a
	mine, yielded := c.Finish("b").Filter([]string{"x.go", "y.go"})
	if strings.Join(mine, ",") != "y.go" || len(yielded) != 1 {
		t.Fatalf("b: mine=%v yielded=%v", mine, yielded)
	}
	// 不同仓库互不影响
	other := t.TempDir()
	c.Register("c", other, other, "", "C")
	c.Register("d", root, root, "", "D")
	c.Touch("c", []string{"x.go"})
	c.Touch("d", []string{"x.go"})
	time.Sleep(20 * time.Millisecond)
	if s.count("c")+s.count("d") != 0 {
		t.Fatalf("different repos must not conflict: %v", s.got)
	}
	if c.Finish("nope") != nil {
		t.Fatal("unregistered tab")
	}
	var nilClaims *Claims
	nilClaims.Register("x", root, root, "", "")
	if mine, _ := nilClaims.Finish("x").Filter([]string{"z"}); len(mine) != 1 {
		t.Fatal("nil claims keeps everything")
	}
}

func TestEditedPaths(t *testing.T) {
	cases := []struct {
		name, input string
		want        []string
	}{
		{"Edit", `{"file_path":"/r/a.go","old_string":"x","new_string":"y"}`, []string{"/r/a.go"}},
		{"MultiEdit", `{"file_path":"b.go","edits":[{"old_string":"a"}]}`, []string{"b.go"}},
		{"apply_patch", `{"changes":[{"path":"c.go","kind":"update"},{"path":"d.go","kind":"add"}]}`, []string{"c.go", "d.go"}},
		{"apply_patch", "*** Begin Patch\n*** Update File: e.go\n@@\n*** Add File: f.go\n*** End Patch", []string{"e.go", "f.go"}},
		{"shell", `{"command":"apply_patch"}`, nil},
		{"Read", `{"file_path":"/r/a.go"}`, nil},
		{"Write", ``, nil},
	}
	for _, c := range cases {
		got := EditedPaths(c.name, c.input)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s %q: got %v want %v", c.name, c.input, got, c.want)
		}
	}
}

func TestFindReusableTab(t *testing.T) {
	now := 10 * ReuseWindowMs * 1.0
	key := ReuseKey("conv", "claude", "/r", "coding", "", "")
	tab := func(id, status, sid string, at float64, extra ...any) any {
		d := util.NewObj("by", "nomi", "reuseKey", key)
		for i := 0; i+1 < len(extra); i += 2 {
			d.Set(extra[i].(string), extra[i+1])
		}
		return util.NewObj("id", id, "status", status, "cliSessionId", sid, "updatedAt", at, "delegation", d)
	}
	busy := func(id string) bool { return id == "task_busy" }
	tabs := []any{
		tab("running", "running", "s", now),
		tab("nosession", "idle", "", now),
		tab("stale", "idle", "s", now-ReuseWindowMs-1),
		tab("taken", "idle", "s", now, "takenOver", true),
		tab("busy", "idle", "s", now, "taskId", "task_busy"),
		tab("older", "idle", "s", now-1000),
		tab("best", "idle", "s", now-10, "taskId", "task_done"),
	}
	if got := FindReusableTab(tabs, key, now, busy); got != "best" {
		t.Fatalf("got %q", got)
	}
	if got := FindReusableTab(tabs, ReuseKey("conv", "codex", "/r", "coding", "", ""), now, busy); got != "" {
		t.Fatalf("different cli must not reuse: %q", got)
	}
	if ReuseKey("", "claude", "/r", "coding", "", "") != "" {
		t.Fatal("no conversation, no reuse")
	}
	if ReuseKey("c", "claude", "/r", "", "", "") != ReuseKey("c", "claude", "/r", "coding", "", "") {
		t.Fatal("kind defaults to coding")
	}
}

func TestReuseOwner(t *testing.T) {
	tabs := []any{
		util.NewObj("id", "a", "delegation", util.NewObj("by", "nomi", "taskId", "task_1")),
		util.NewObj("id", "b", "delegation", util.NewObj("by", "nomi")),
		util.NewObj("id", "c"),
	}
	if ReuseOwner(tabs, "a") != "task_1" || ReuseOwner(tabs, "b") != "" || ReuseOwner(tabs, "c") != "" || ReuseOwner(tabs, "x") != "" {
		t.Fatal("owner")
	}
}
