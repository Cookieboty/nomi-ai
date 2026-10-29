package mousetrack

import (
	"strings"
	"testing"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func TestMouseTrack(t *testing.T) {
	var got []string
	cx, cy, ok := 0, 0, true
	tr := New(Deps{
		Bounds:  func() (shell.Rect, bool) { return shell.Rect{X: 10, Y: 20, Width: 100, Height: 50}, ok },
		Cursor:  func() (int, int) { return cx, cy },
		Publish: func(e string) { got = append(got, e) },
	})
	step := func(x, y int) { cx, cy = x, y; tr.Check() }
	step(0, 0)    // 起始在外：不发
	step(10, 20)  // 左上角（含边）
	step(50, 40)  // 仍在内：不重复
	step(110, 70) // 右下角（含边）
	step(111, 70) // 出
	step(110, 40) // 右边上（含边）：进
	step(110, 71) // 下边外：出
	step(60, 45)  // 进
	ok = false
	step(500, 500) // 窗口没了：不检查
	want := "window.mouseEnter,window.mouseLeave,window.mouseEnter,window.mouseLeave,window.mouseEnter"
	if strings.Join(got, ",") != want {
		t.Fatalf("got %v want %s", got, want)
	}
}
