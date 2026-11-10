//go:build !(darwin && cgo)

package wailsshell

import "github.com/wailsapp/wails/v3/pkg/application"

// acceptFirstMouse：只有 mac 会把非活动窗口的第一下点击吞掉（Windows / Linux 照常交给网页）
func acceptFirstMouse(*application.WebviewWindow) {}
