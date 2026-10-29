//go:build linux && cgo

package wailsshell

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>

static void nomi_cursor(int *x, int *y) {
	GdkDisplay *d = gdk_display_get_default();
	*x = 0; *y = 0;
	if (!d) return;
	GdkDevice *p = gdk_seat_get_pointer(gdk_display_get_default_seat(d));
	if (p) gdk_device_get_position(p, NULL, x, y);
}

// 输入形状：形状外的点击穿透到下层窗口（Electron setShape 在 Linux 上的等价物）
static void nomi_input_shape(void *win, int *r, int n) {
	GtkWidget *w = GTK_WIDGET(win);
	cairo_region_t *reg = cairo_region_create();
	for (int i = 0; i < n; i++) {
		cairo_rectangle_int_t rc = { r[4*i], r[4*i+1], r[4*i+2], r[4*i+3] };
		cairo_region_union_rectangle(reg, &rc);
	}
	gtk_widget_input_shape_combine_region(w, reg);
	cairo_region_destroy(reg);
}
*/
import "C"

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/shell"
)

func nativeCursor(*application.App) (int, int) {
	var x, y C.int
	application.InvokeSync(func() { C.nomi_cursor(&x, &y) })
	return int(x), int(y)
}

func nativeInputShape(win *application.WebviewWindow, rects []shell.Rect) {
	buf := make([]C.int, 0, 4*len(rects))
	for _, r := range rects {
		buf = append(buf, C.int(r.X), C.int(r.Y), C.int(r.Width), C.int(r.Height))
	}
	application.InvokeSync(func() {
		p := win.NativeWindow()
		if p == nil {
			return
		}
		var ptr *C.int
		if len(buf) > 0 {
			ptr = &buf[0]
		}
		C.nomi_input_shape(p, ptr, C.int(len(rects)))
	})
}
