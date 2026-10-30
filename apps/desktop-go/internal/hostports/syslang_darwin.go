package hostports

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <stdlib.h>

static char *nomiPreferredLanguages(void) {
	@autoreleasepool {
		NSString *s = [[NSLocale preferredLanguages] componentsJoinedByString:@"\n"];
		return strdup(s.UTF8String ? s.UTF8String : "");
	}
}
*/
import "C"

import (
	"strings"
	"unsafe"
)

// preferredLanguages = [NSLocale preferredLanguages]（Electron getPreferredSystemLanguages 在 mac 上的来源）
func preferredLanguages() []string {
	p := C.nomiPreferredLanguages()
	defer C.free(unsafe.Pointer(p))
	var out []string
	for _, l := range strings.Split(C.GoString(p), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}
