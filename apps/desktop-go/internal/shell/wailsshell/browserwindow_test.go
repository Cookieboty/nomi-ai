package wailsshell

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// regionToView：区域（左上原点）→ NSView 坐标（左下原点）
//
// 这是 macOS 子视图唯一的坐标换算，也是最容易写反的一处：y 要从内容区底部往上算。
func TestRegionToViewFlipsY(t *testing.T) {
	// 内容区高 800：区域在顶部下方 100 处、高 600 → 视图坐标 y = 800 - 100 - 600 = 100
	x, y, w, h, ok := regionToView(shell.BrowserRegion{X: 40, Y: 100, Width: 600, Height: 600}, 800)
	if !ok {
		t.Fatal("应当摆得下")
	}
	if x != 40 || y != 100 || w != 600 || h != 600 {
		t.Fatalf("got (%v, %v, %v, %v)", x, y, w, h)
	}
}

func TestRegionToViewSitsOnTheBottom(t *testing.T) {
	// 贴着内容区底部（top = 内容高度 - 区域高度）：视图坐标 y 应该是 0
	if _, y, _, _, ok := regionToView(shell.BrowserRegion{Y: 300, Width: 600, Height: 200}, 500); !ok || y != 0 {
		t.Fatalf("y = %v（ok=%v），贴着底边时应当是 0", y, ok)
	}
	// 贴着顶部的区域：视图坐标 y = 内容高度 - 区域高度
	if _, y, _, _, ok := regionToView(shell.BrowserRegion{Width: 600, Height: 200}, 500); !ok || y != 300 {
		t.Fatalf("顶边区域 y = %v，应当是 300", y)
	}
}

func TestRegionToViewRejectsUnusable(t *testing.T) {
	cases := []struct {
		name    string
		region  shell.BrowserRegion
		content float64
	}{
		{name: "太窄", region: shell.BrowserRegion{Width: minBrowserWidth - 1, Height: 400}, content: 800},
		{name: "太矮", region: shell.BrowserRegion{Width: 600, Height: minBrowserHeight - 1}, content: 800},
		{name: "全零", region: shell.BrowserRegion{}, content: 800},
		{name: "内容区还没布局", region: shell.BrowserRegion{Width: 600, Height: 400}, content: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, _, _, ok := regionToView(tc.region, tc.content); ok {
				t.Fatal("不该摆得下")
			}
		})
	}
}

func TestRegionToViewAllowsNegativePosition(t *testing.T) {
	// 面板滑动中区域可能整个滑到可视区外：坐标可以是负的，只要尺寸够就得摆上（否则拖回来会闪）
	_, y, _, _, ok := regionToView(shell.BrowserRegion{X: -300, Y: -40, Width: 600, Height: 400}, 800)
	if !ok {
		t.Fatal("尺寸够就该摆上")
	}
	if y != 800-(-40)-400 {
		t.Fatalf("y = %v", y)
	}
}

// browserRect 只给独立窗口的平台用（Linux）：区域 → 屏幕绝对坐标
func TestBrowserRectOffsetsByChatWindow(t *testing.T) {
	chat := application.Rect{X: 100, Y: 50, Width: 1200, Height: 800}
	got, ok := browserRect(chat, 0, 0, shell.BrowserRegion{X: 20, Y: 40, Width: 600, Height: 400})
	if !ok {
		t.Fatal("应当摆得下")
	}
	want := application.Rect{X: 120, Y: 90, Width: 600, Height: 400}
	if got != want {
		t.Fatalf("rect = %+v, want %+v", got, want)
	}
}

func TestBrowserRectAddsBorderOffset(t *testing.T) {
	chat := application.Rect{X: 0, Y: 0, Width: 1200, Height: 800}
	got, ok := browserRect(chat, 1, 30, shell.BrowserRegion{Width: 600, Height: 400})
	if !ok || got.X != 1 || got.Y != 30 {
		t.Fatalf("rect = %+v", got)
	}
}

func TestBrowserRectNeedsAChatWindow(t *testing.T) {
	if _, ok := browserRect(application.Rect{}, 0, 0, shell.BrowserRegion{Width: 600, Height: 400}); ok {
		t.Fatal("对话窗口还没建出来时不该摆")
	}
}
