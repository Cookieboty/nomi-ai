package island

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"
)

type pendHost struct {
	mu      sync.Mutex
	lists   [][]Pending
	failed  []string
	hidden  int
	resized []WinRect
}

func (p *pendHost) host() Host {
	return Host{
		Present: func(Notice) error { return nil },
		Hide:    func() { p.mu.Lock(); p.hidden++; p.mu.Unlock() },
		ShowPending: func(l []Pending, _ Labels) error {
			p.mu.Lock()
			p.lists = append(p.lists, l)
			p.mu.Unlock()
			return nil
		},
		ActFailed: func(id string) { p.mu.Lock(); p.failed = append(p.failed, id); p.mu.Unlock() },
		Resize:    func(r WinRect) { p.mu.Lock(); p.resized = append(p.resized, r); p.mu.Unlock() },
	}
}

var allow = []Action{{ID: "allow", Label: "允许", Primary: true}, {ID: "deny", Label: "拒绝"}}

// 等你处理的事：先来的排前面；没变不打扰页面；处理交给 resolver，失败让页面恢复按钮；
// 关掉「等你处理」时收起，再打开时恢复
func TestPendingList(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "darwin")
	h := &pendHost{}
	s.SetHost(h.host())
	var acted []string
	s.SetResolver(func(id, action string) error {
		acted = append(acted, id+"/"+action)
		if id == "gone" {
			return errors.New("already handled")
		}
		return nil
	})
	s.SetPending([]Pending{
		{ID: "b", Title: "后来的", Actions: allow, At: 2},
		{ID: "a", Title: "先来的", Actions: allow, At: 1},
	})
	if len(h.lists) != 1 || h.lists[0][0].ID != "a" {
		t.Fatalf("oldest first: %+v", h.lists)
	}
	s.SetPending([]Pending{{ID: "a", Title: "先来的", Actions: allow, At: 1}, {ID: "b", Title: "后来的", Actions: allow, At: 2}})
	if len(h.lists) != 1 {
		t.Fatal("unchanged list is not pushed again")
	}
	if err := s.Act("a", "allow"); err != nil || acted[0] != "a/allow" {
		t.Fatalf("act: %v %v", err, acted)
	}
	if err := s.Act("zzz", "allow"); !errors.Is(err, ErrUnknownPending) || h.failed[0] != "zzz" {
		t.Fatalf("unknown id restores the buttons: %v %v", err, h.failed)
	}
	// 有等你处理的事时，通知那一行收掉不隐藏窗口
	s.Hidden()
	if h.hidden != 0 {
		t.Fatal("window stays while things are waiting")
	}
	if _, err := s.Set(map[string]any{"kinds": map[string]any{"approval": false}}); err != nil {
		t.Fatal(err)
	}
	if last := h.lists[len(h.lists)-1]; len(last) != 0 || len(s.Pending()) != 0 {
		t.Fatalf("turning approvals off clears the island: %+v", last)
	}
	if _, err := s.Set(map[string]any{"kinds": map[string]any{"approval": true}}); err != nil {
		t.Fatal(err)
	}
	if last := h.lists[len(h.lists)-1]; len(last) != 2 {
		t.Fatalf("turning it back on restores the list: %+v", last)
	}
	s.SetPending(nil)
	s.Hidden()
	if h.hidden != 1 {
		t.Fatal("nothing left: hide the window")
	}
}

// 页面报来的高度：不低于一条、不高于列表上限，换算成窗口矩形
func TestResizedClampsHeight(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "island.json"), "win32")
	h := &pendHost{}
	s.SetHost(h.host())
	d := Display{Bounds: Rect{Width: 1440, Height: 900}, WorkArea: Rect{Y: 25, Width: 1440, Height: 875}}
	s.PrimaryDisplay = func() (Display, bool) { return d, true }
	g, _ := s.Layout()
	s.Resized(10)
	s.Resized(5000)
	if h.resized[0].Height != g.Height+g.Margin.Bottom {
		t.Fatalf("min one row: %+v", h.resized[0])
	}
	if max := g.Pad.Top + g.Pad.Bottom + MaxContent + g.Margin.Bottom; h.resized[1].Height != max {
		t.Fatalf("max list: %+v want %v", h.resized[1], max)
	}
	if g.Width != IslandWidth || g.Height != 64 {
		t.Fatalf("one row is a 440×64 pill: %+v", g)
	}
}
