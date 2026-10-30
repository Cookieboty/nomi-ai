//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// = nativeTheme.themeSource：0 跟随系统，1 浅色，2 深色（整个应用）
static void nomi_set_appearance(int mode) {
	NSAppearance *a = nil;
	if (mode == 1) a = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
	if (mode == 2) a = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
	[NSApp setAppearance:a];
}
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// SetAppearance = appearance.setWindowAppearance（system | light | dark）
func (w *Wails) SetAppearance(mode string) {
	m := C.int(0)
	switch mode {
	case "light":
		m = 1
	case "dark":
		m = 2
	}
	w.whenStarted(func() { application.InvokeAsync(func() { C.nomi_set_appearance(m) }) })
}
