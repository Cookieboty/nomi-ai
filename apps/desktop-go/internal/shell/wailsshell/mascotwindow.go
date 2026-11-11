package wailsshell

import "github.com/wailsapp/wails/v3/pkg/application"

// The desktop character is an auxiliary panel, never a primary fullscreen window.
// Keep the active app and chat's keyboard focus when it is shown or recreated.
func mascotMacWindow(alwaysOnTop bool) application.MacWindow {
	options := application.MacWindow{
		Backdrop:      application.MacBackdropTransparent,
		DisableShadow: true,
		CornerType:    application.MacWindowCornerTypeSquare,
		WindowClass:   application.MacWindowClassPanel,
		PanelPreferences: application.MacPanelPreferences{
			NonActivating: true,
			FloatingPanel: true,
		},
		CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces |
			application.MacWindowCollectionBehaviorTransient |
			application.MacWindowCollectionBehaviorIgnoresCycle |
			application.MacWindowCollectionBehaviorFullScreenAuxiliary,
	}
	if !alwaysOnTop {
		options.WindowLevel = application.MacWindowLevelNormal
	}
	return options
}
