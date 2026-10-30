package shell

import "testing"

func TestRestoreChatBounds(t *testing.T) {
	primary := Rect{X: 0, Y: 25, Width: 1440, Height: 875}
	second := Rect{X: 1440, Y: 0, Width: 1920, Height: 1080}
	areas := []Rect{primary, second}
	sb := func(x, y, w, h int, max bool) *SavedChatBounds {
		return &SavedChatBounds{Rect: Rect{X: x, Y: y, Width: w, Height: h}, Maximized: max}
	}
	cases := []struct {
		name  string
		saved *SavedChatBounds
		areas []Rect
		want  *SavedChatBounds
	}{
		{"no record", nil, areas, nil},
		{"no displays", sb(10, 10, 800, 600, false), nil, nil},
		{"kept on its screen", sb(100, 100, 900, 700, false), areas, sb(100, 100, 900, 700, false)},
		{"on the second screen", sb(1600, 50, 1000, 800, true), areas, sb(1600, 50, 1000, 800, true)},
		{"clamped to min size", sb(100, 100, 300, 200, false), areas, sb(100, 100, 760, 560, false)},
		{"clamped to the work area size", sb(0, 25, 3000, 2000, false), areas, sb(0, 25, 1440, 875, false)},
		// 外接屏拔掉了：回主屏居中
		{"off every screen → centered on primary", sb(5000, 5000, 900, 700, false), areas, sb(270, 113, 900, 700, false)},
		// 标题栏跑到工作区上面：拉回来
		{"title bar above the work area", sb(100, -10, 900, 700, false), areas, sb(100, 25, 900, 700, false)},
		{"overhanging right edge", sb(1000, 100, 900, 700, false), []Rect{primary}, sb(540, 100, 900, 700, false)},
	}
	for _, c := range cases {
		got := RestoreChatBounds(c.saved, c.areas, ChatMinSize)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestChatWindowBoundsDefault(t *testing.T) {
	// 没有记录：主屏 min(1120, w-40) × min(820, h-40)，按 workAreaSize 居中
	got := ChatWindowBounds(nil, []Rect{{X: 0, Y: 25, Width: 1440, Height: 875}})
	want := SavedChatBounds{Rect: Rect{X: 160, Y: 28, Width: 1120, Height: 820}}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	small := ChatWindowBounds(nil, []Rect{{Width: 1000, Height: 700}})
	if small.Width != 960 || small.Height != 660 {
		t.Fatalf("small screen: %+v", small)
	}
}
