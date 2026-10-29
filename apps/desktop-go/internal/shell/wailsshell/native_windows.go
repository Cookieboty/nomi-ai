//go:build windows

package wailsshell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/w32"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

// = Electron ScreenWin::GetCursorScreenPoint：物理像素 → DIP
func nativeCursor(app *application.App) (int, int) {
	x, y, ok := w32.GetCursorPos()
	if !ok {
		return 0, 0
	}
	p := app.Screen.PhysicalToDipPoint(application.Point{X: x, Y: y})
	return p.X, p.Y
}

func nativeInputShape(*application.WebviewWindow, []shell.Rect) {}
