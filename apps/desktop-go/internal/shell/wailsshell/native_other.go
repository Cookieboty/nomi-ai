//go:build !windows && !(linux && cgo) && !(darwin && cgo)

package wailsshell

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func nativeCursor(*application.App) (int, int)                  { return 0, 0 }
func nativeInputShape(*application.WebviewWindow, []shell.Rect) {}
