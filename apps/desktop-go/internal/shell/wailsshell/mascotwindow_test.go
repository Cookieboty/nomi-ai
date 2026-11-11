package wailsshell

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"testing"
)

func TestMascotIsANonActivatingFullscreenAuxiliaryPanel(t *testing.T) {
	options := mascotMacWindow(true)
	if options.WindowClass != application.MacWindowClassPanel || !options.PanelPreferences.NonActivating || !options.PanelPreferences.FloatingPanel {
		t.Fatalf("showing the character must not activate a primary application window: %+v", options)
	}
	if options.Backdrop != application.MacBackdropTransparent || !options.DisableShadow || options.CornerType != application.MacWindowCornerTypeSquare {
		t.Fatalf("the transparent character canvas must remain borderless and shadowless: %+v", options)
	}
	required := application.MacWindowCollectionBehaviorCanJoinAllSpaces |
		application.MacWindowCollectionBehaviorTransient |
		application.MacWindowCollectionBehaviorIgnoresCycle |
		application.MacWindowCollectionBehaviorFullScreenAuxiliary
	if options.CollectionBehavior&required != required {
		t.Fatalf("the character must be an auxiliary panel across desktops and fullscreen spaces: %d", options.CollectionBehavior)
	}
	forbidden := application.MacWindowCollectionBehaviorManaged |
		application.MacWindowCollectionBehaviorStationary |
		application.MacWindowCollectionBehaviorParticipatesInCycle |
		application.MacWindowCollectionBehaviorFullScreenPrimary
	if options.CollectionBehavior&forbidden != 0 {
		t.Fatalf("the character must never become a primary fullscreen window or combine conflicting behaviors: %d", options.CollectionBehavior)
	}
}

func TestMascotPanelRespectsDisabledAlwaysOnTop(t *testing.T) {
	options := mascotMacWindow(false)
	if options.WindowLevel != application.MacWindowLevelNormal {
		t.Fatalf("a recreated character must preserve the user's disabled always-on-top setting: %+v", options)
	}
	if options.WindowClass != application.MacWindowClassPanel || !options.PanelPreferences.NonActivating {
		t.Fatal("disabling always-on-top must not turn the character into an activating main window")
	}
}
