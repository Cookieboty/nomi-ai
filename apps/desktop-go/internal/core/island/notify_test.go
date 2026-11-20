package island

import (
	"path/filepath"
	"slices"
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

// shownNotices：已展示的通知快照（Present 在 notify.go 的 pump 协程里追加，读的一方必须有锁）
func (r *recHost) shownNotices() []Notice {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.shown)
}

func (r *recHost) shownTitles() []string {
	var out []string
	for _, n := range r.shownNotices() {
		out = append(out, n.Title)
	}
	return out
}

func (r *recHost) openedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.opened
}

func (r *recHost) destroyedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.destroyed
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
	if r.openedCount() != 1 {
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
	if destroyed := r.destroyedCount(); destroyed != 1 || s.Accepts(Notice{Kind: "info"}, false) {
		t.Fatalf("disable: destroyed=%d", destroyed)
	}
}

func TestIslandNoticeTruncation(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	r := &recHost{}
	s.SetHost(r.host())
	long := strings.Repeat("字", 100)
	s.Notify(Notice{Kind: "info", Title: long, Body: strings.Repeat("x", 300), Endpoint: strings.Repeat("e", 40)}, false)
	waitFor(t, func() bool { return len(r.shownTitles()) == 1 })
	n := r.shownNotices()[0]
	if len([]rune(n.Title)) != 80 || len(n.Body) != 160 || len(n.Endpoint) != 24 {
		t.Fatalf("truncation: %d %d %d", len([]rune(n.Title)), len(n.Body), len(n.Endpoint))
	}
}

func TestIslandNoticeOpenTarget(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	r := &recHost{}
	s.SetHost(r.host())
	var opened []string
	s.SetOpener(func(id string) { opened = append(opened, id) })

	if !s.Notify(Notice{Kind: "agent", Title: "Codex", Session: "tab_3"}, false) {
		t.Fatal("notify rejected")
	}
	waitFor(t, func() bool { return len(r.shownNotices()) == 1 })
	if got := r.shownNotices()[0].OpenID; got != "tab\x1ftab_3" {
		t.Fatalf("expected OpenID tab\\x1ftab_3, got %q", got)
	}

	// Opened() 正在展示带 OpenID 的通知时直接跳转 opener
	// 失败路径也要走加锁的快照：直接在 Fatalf 参数里读 r.opened 会和 host() 的 OpenChat 抢
	s.Opened()
	if chatOpened := r.openedCount(); len(opened) != 1 || opened[0] != "tab\x1ftab_3" || chatOpened != 0 {
		t.Fatalf("Opened() with currentOpen: opened=%v chatOpened=%d", opened, chatOpened)
	}

	// 即便点击触发 dismiss 导致 Hidden() 先到，OpenItem 仍能命中最近记忆的 noticeOpens
	s.Hidden()
	s.OpenItem("tab\x1ftab_3")
	if len(opened) != 2 || opened[1] != "tab\x1ftab_3" {
		t.Fatalf("OpenItem after Hidden(): opened=%v", opened)
	}

	// 无当前通知或通知无 OpenID 时，Opened() 回退 OpenChat
	s.Opened()
	if got := r.openedCount(); got != 1 {
		t.Fatalf("Opened() without showing notice should open chat, got %d", got)
	}
}
