package shell

import "math"

// 对话窗口（主界面）的位置与大小 = host-electron core/chatWindowBounds.ts + WindowManager.buildAiChatWindow：
// 关闭时记下（config.json 的 chatWindowBounds），下次打开时按当前显示器校正后恢复；没有记录时居中默认尺寸。

// ChatMinSize = WindowManager CHAT_MIN_SIZE
var ChatMinSize = Rect{Width: 760, Height: 560}

// chatVisibleMin：至少要有这么大一块落在某个屏幕的工作区里，才算「还在屏幕上」
const chatVisibleMin = 120

// SavedChatBounds = SavedChatBounds（maximized：关闭时是最大化的，恢复为最大化）
type SavedChatBounds struct {
	Rect
	Maximized bool
}

func overlap(a, b Rect) (int, int) {
	w := min(a.X+a.Width, b.X+b.Width) - max(a.X, b.X)
	h := min(a.Y+a.Height, b.Y+b.Height) - max(a.Y, b.Y)
	return w, h
}

func jsRound(v float64) int { return int(math.Floor(v + 0.5)) }

// RestoreChatBounds = restoreChatBounds：saved 为 nil 或没有工作区时返回 nil（调用方用默认的居中尺寸）。
// workAreas[0] 视为主屏。
func RestoreChatBounds(saved *SavedChatBounds, workAreas []Rect, minSize Rect) *SavedChatBounds {
	if saved == nil || len(workAreas) == 0 {
		return nil
	}
	var host *Rect
	for i := range workAreas {
		if w, h := overlap(saved.Rect, workAreas[i]); w >= chatVisibleMin && h >= chatVisibleMin {
			host = &workAreas[i]
			break
		}
	}
	area := workAreas[0]
	if host != nil {
		area = *host
	}
	width := min(area.Width, max(minSize.Width, saved.Width))
	height := min(area.Height, max(minSize.Height, saved.Height))
	x, y := saved.X, saved.Y
	if host == nil {
		x = jsRound(float64(area.X) + float64(area.Width-width)/2)
		y = jsRound(float64(area.Y) + float64(area.Height-height)/2)
	}
	// 标题栏必须在工作区里（拖得回来）；整体也不超出工作区右下
	x = min(max(x, area.X), area.X+area.Width-width)
	y = min(max(y, area.Y), area.Y+area.Height-height)
	return &SavedChatBounds{Rect: Rect{X: x, Y: y, Width: width, Height: height}, Maximized: saved.Maximized}
}

// ChatWindowBounds = buildAiChatWindow 的取值：恢复上次的位置大小，否则主屏工作区居中
// min(1120, 宽-40) × min(820, 高-40)。primary 是主屏工作区（Electron 用 workAreaSize，x/y 不加原点）。
func ChatWindowBounds(saved *SavedChatBounds, workAreas []Rect) SavedChatBounds {
	if r := RestoreChatBounds(saved, workAreas, ChatMinSize); r != nil {
		return *r
	}
	var primary Rect
	if len(workAreas) > 0 {
		primary = workAreas[0]
	}
	w := min(1120, primary.Width-40)
	h := min(820, primary.Height-40)
	return SavedChatBounds{Rect: Rect{
		X: jsRound(float64(primary.Width-w) / 2), Y: jsRound(float64(primary.Height-h) / 2), Width: w, Height: h,
	}}
}
