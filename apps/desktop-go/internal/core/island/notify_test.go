package island

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type recHost struct {
	mu        sync.Mutex
	shown     []Notice
	hidden    int
	destroyed int
	opened    int
	quiet     bool
}

func (r *recHost) host() Host {
	return Host{
		Present: func(n Notice) error {
			r.mu.Lock()
			r.shown = append(r.shown, n)
			r.mu.Unlock()
			return nil
		},
		Hide:     func() { r.mu.Lock(); r.hidden++; r.mu.Unlock() },
		Destroy:  func() { r.mu.Lock(); r.destroyed++; r.mu.Unlock() },
		OpenChat: func() { r.mu.Lock(); r.opened++; r.mu.Unlock() },
		IsQuiet:  func() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.quiet },
	}
}

func (r *recHost) shownTitles() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, n := range r.shown {
		out = append(out, n.Title)
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestIslandNotifyPipeline(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin") // mac 默认开
	r := &recHost{}
	s.SetHost(r.host())

	if !s.Notify(Notice{Kind: "agent", Title: "a", Body: "1"}, false) {
		t.Fatal("enabled island should accept")
	}
	waitFor(t, func() bool { return len(r.shownTitles()) == 1 })

	// 正在显示：后面的排队；同样内容不重复排
	s.Notify(Notice{Kind: "message", Title: "b", Body: "2"}, false)
	s.Notify(Notice{Kind: "message", Title: "b", Body: "2"}, false)
	s.Notify(Notice{Kind: "info", Title: "c"}, false)
	time.Sleep(20 * time.Millisecond)
	if got := r.shownTitles(); len(got) != 1 {
		t.Fatalf("only one at a time, got %v", got)
	}
	// 收起 → 隐藏窗口、显示下一条
	s.Hidden()
	waitFor(t, func() bool { return len(r.shownTitles()) == 2 })
	s.Hidden()
	waitFor(t, func() bool { return len(r.shownTitles()) == 3 })
	if got := strings.Join(r.shownTitles(), ","); got != "a,b,c" {
		t.Fatalf("order %s", got)
	}

	// 点击 → 打开对话
	s.Opened()
	if r.opened != 1 {
		t.Fatal("click should open chat")
	}

	// 类型开关 / 免打扰 / force
	_, _ = s.Set(map[string]any{"kinds": map[string]any{"agent": false}})
	if s.Accepts(Notice{Kind: "agent"}, false) || !s.Accepts(Notice{Kind: "info"}, false) {
		t.Fatal("kind filter")
	}
	r.mu.Lock()
	r.quiet = true
	r.mu.Unlock()
	if s.Accepts(Notice{Kind: "message"}, false) || !s.Accepts(Notice{Kind: "message"}, true) {
		t.Fatal("quiet hours / force")
	}

	// 关掉开关：释放窗口，之后不接受
	_, _ = s.Set(map[string]any{"enabled": false})
	if r.destroyed != 1 || s.Accepts(Notice{Kind: "info"}, false) {
		t.Fatalf("disable: destroyed=%d", r.destroyed)
	}
}

func TestIslandNoticeTruncation(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	r := &recHost{}
	s.SetHost(r.host())
	long := strings.Repeat("字", 100)
	s.Notify(Notice{Kind: "info", Title: long, Body: strings.Repeat("x", 300), Endpoint: strings.Repeat("e", 40)}, false)
	waitFor(t, func() bool { return len(r.shownTitles()) == 1 })
	n := r.shown[0]
	if len([]rune(n.Title)) != 80 || len(n.Body) != 160 || len(n.Endpoint) != 24 {
		t.Fatalf("truncation: %d %d %d", len([]rune(n.Title)), len(n.Body), len(n.Endpoint))
	}
}
