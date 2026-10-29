// Package shell 定义外壳层接口：核心只认这几个窗口 / 托盘能力，Wails v3 与 MyGo 各写一个实现即可替换。
package shell

type WindowKind string

const (
	Mascot WindowKind = "mascot"
	Chat   WindowKind = "chat"
)

// Shell 是外壳要提供给核心的最小能力集
type Shell interface {
	// Show 创建（如已销毁）并显示窗口
	Show(k WindowKind)
	// Destroy 销毁窗口及其 WebView（看板娘隐藏、对话窗关闭都走这里，和 2.0.5 一致）
	Destroy(k WindowKind)
	Visible(k WindowKind) bool
	Run() error
	Quit()
}
