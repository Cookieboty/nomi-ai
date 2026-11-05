package wailsshell

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestTransparentWindowsDoNotCastNativeShadows(t *testing.T) {
	for _, options := range []application.MacWindow{
		transparentMacWindow(), transparentMacWindow(application.MacWindowLevelStatus),
	} {
		if options.Backdrop != application.MacBackdropTransparent || !options.DisableShadow {
			t.Fatalf("transparent windows must rely on UI shadows only: %+v", options)
		}
	}
	if transparentMacWindow(application.MacWindowLevelStatus).WindowLevel != application.MacWindowLevelStatus {
		t.Fatal("island notification window level changed")
	}
	if (application.MacWindow{TitleBar: application.MacTitleBarHidden}).DisableShadow {
		t.Fatal("normal chat window shadows should remain enabled")
	}
}
