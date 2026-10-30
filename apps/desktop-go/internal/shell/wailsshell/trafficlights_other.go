//go:build !(darwin && cgo)

package wailsshell

import "github.com/wailsapp/wails/v3/pkg/application"

// placeTrafficLights：只有 mac 有红绿灯
func placeTrafficLights(*application.WebviewWindow) {}
