package wailsshell

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestIslandIsATransientNonActivatingNotificationPanel(t *testing.T) {
	options := islandMacWindow()
	if options.WindowClass != application.MacWindowClassPanel || !options.PanelPreferences.NonActivating || !options.PanelPreferences.FloatingPanel {
		t.Fatalf("notifications must not activate a main application window: %+v", options)
	}
	if options.WindowLevel != application.MacWindowLevelStatus || options.CornerType != application.MacWindowCornerTypeSquare || options.Backdrop != application.MacBackdropTransparent || !options.DisableShadow {
		t.Fatalf("notification positioning and transparency changed: %+v", options)
	}
	required := application.MacWindowCollectionBehaviorTransient |
		application.MacWindowCollectionBehaviorIgnoresCycle |
		application.MacWindowCollectionBehaviorCanJoinAllSpaces |
		application.MacWindowCollectionBehaviorFullScreenAuxiliary
	if options.CollectionBehavior&required != required {
		t.Fatalf("notifications must be excluded from Expose/cycling and available over fullscreen: %d", options.CollectionBehavior)
	}
	forbidden := application.MacWindowCollectionBehaviorManaged |
		application.MacWindowCollectionBehaviorStationary |
		application.MacWindowCollectionBehaviorParticipatesInCycle |
		application.MacWindowCollectionBehaviorFullScreenPrimary
	if options.CollectionBehavior&forbidden != 0 {
		t.Fatalf("a notification must not become a main/fullscreen window or combine conflicting behavior groups: %d", options.CollectionBehavior)
	}
}
