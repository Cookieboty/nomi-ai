//go:build !(darwin && cgo)

package wailsshell

// SetAppearance：只有 mac 有应用级外观
func (w *Wails) SetAppearance(string) {}
