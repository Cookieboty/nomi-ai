package wailsshell

import "github.com/wailsapp/wails/v3/pkg/application"

// 通知浮窗使用非激活 NSPanel，避免进入窗口概览与窗口轮换。
// Wails 的零 CollectionBehavior 会落到 FullScreenPrimary，必须显式设置。
func islandMacWindow() application.MacWindow {
	return application.MacWindow{
		Backdrop:      application.MacBackdropTransparent,
		WindowLevel:   application.MacWindowLevelStatus,
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
}
