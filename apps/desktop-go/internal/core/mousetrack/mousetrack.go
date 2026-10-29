// Package mousetrack = WindowManager.setupMousePositionTracking（packages/host-electron）：
// 每 100ms 比较光标与看板娘窗口边界（含边），进出时只向 mascot 面发布 window.mouseEnter / window.mouseLeave（null）。
package mousetrack

import (
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// IntervalMs = setInterval(checkMousePosition, 100)
const IntervalMs = 100

// Deps 窗口几何与发布
type Deps struct {
	// Bounds = window.getBounds()；窗口不存在（isDestroyed）返回 false
	Bounds func() (shell.Rect, bool)
	// Cursor = screen.getCursorScreenPoint()
	Cursor func() (int, int)
	// Publish = events.publish(name, null, { surface: 'mascot' })
	Publish func(event string)
}

// Tracker 单个窗口的进出状态（mouseInWindow）
type Tracker struct {
	d  Deps
	in bool
}

func New(d Deps) *Tracker { return &Tracker{d: d} }

// Check = checkMousePosition（一次）
func (t *Tracker) Check() {
	b, ok := t.d.Bounds()
	if !ok {
		return
	}
	x, y := t.d.Cursor()
	in := x >= b.X && x <= b.X+b.Width && y >= b.Y && y <= b.Y+b.Height
	if in != t.in {
		t.in = in
		if in {
			t.d.Publish("window.mouseEnter")
		} else {
			t.d.Publish("window.mouseLeave")
		}
	}
}

// Run 每 IntervalMs 检查一次，直到 stop 关闭
func (t *Tracker) Run(stop <-chan struct{}) {
	tk := time.NewTicker(IntervalMs * time.Millisecond)
	defer tk.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tk.C:
			t.Check()
		}
	}
}
