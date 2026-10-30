//go:build !(darwin && cgo)

package wailsshell

// SetAppearance：只有 mac 有应用级外观（Electron 的 syncAppearance 同样只在 darwin 生效）
func (w *Wails) SetAppearance(string) {}
