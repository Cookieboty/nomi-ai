package wailsshell

import "github.com/wailsapp/wails/v3/pkg/application"

// Native shadows outline the transparent webview alpha (bubble, toolbar and
// animation frames), leaving a dark ghost around the desktop character.
// The web UI already supplies its own shadows. Regular chat windows keep theirs.
func transparentMacWindow(level ...application.MacWindowLevel) application.MacWindow {
	options := application.MacWindow{
		Backdrop:      application.MacBackdropTransparent,
		DisableShadow: true,
	}
	if len(level) > 0 {
		options.WindowLevel = level[0]
	}
	return options
}
