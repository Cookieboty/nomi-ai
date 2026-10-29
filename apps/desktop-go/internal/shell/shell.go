// Package shell 定义外壳层接口：核心只认这几个窗口 / 托盘能力，Wails v3 与 MyGo 各写一个实现即可替换。
package shell

type WindowKind string

const (
	Mascot WindowKind = "mascot"
	Chat   WindowKind = "chat"
	// Island 是屏幕顶部居中的通知条（灵动岛），透明、无边框、置顶、不抢焦点
	Island WindowKind = "island"
)

// Shell 是外壳要提供给核心的最小能力集
type Shell interface {
	// Show 创建（如已销毁）并显示窗口
	Show(k WindowKind)
	// Destroy 销毁窗口及其 WebView（看板娘隐藏、对话窗关闭都走这里，和 2.0.5 一致）
	Destroy(k WindowKind)
	Visible(k WindowKind) bool
	// TrayAvailable：托盘是否真的建起来了（Linux 没有 SNI 宿主时为 false，界面需另给入口）
	TrayAvailable() bool
	Run() error
	Quit()
}

// Rect 是屏幕坐标（逻辑像素）
type Rect struct{ X, Y, Width, Height int }

// WorkArea 是一个显示器的工作区
type WorkArea struct {
	Rect
	ScaleFactor float64
}

// Geometry 是看板娘需要的窗口几何能力（可选：外壳实现了才有缩放 / 拖拽 / 位置）
type Geometry interface {
	Bounds(k WindowKind) (Rect, bool)
	SetBounds(k WindowKind, r Rect)
	SetAlwaysOnTop(k WindowKind, on bool)
	WorkAreas() []WorkArea
}
