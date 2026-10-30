//go:build !windows && !(darwin && cgo)

package wailsshell

// ClipboardFilePaths：Linux 的剪贴板文件（text/uri-list）Wails 读不到，粘贴的文件没有路径
func (w *Wails) ClipboardFilePaths() []string { return nil }
