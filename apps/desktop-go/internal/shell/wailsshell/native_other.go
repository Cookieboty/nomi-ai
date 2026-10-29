//go:build !windows && !(linux && cgo) && !(darwin && cgo)

package wailsshell

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func nativeCursor(*application.App) (int, int)                  { return 0, 0 }
func nativeInputShape(*application.WebviewWindow, []shell.Rect) {}

func nativeSetWindowIcon(unsafe.Pointer, []byte)                    {}
func nativeSetAppDetails(unsafe.Pointer, string, string, int) error { return nil }
