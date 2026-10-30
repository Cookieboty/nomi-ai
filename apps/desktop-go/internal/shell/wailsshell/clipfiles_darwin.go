//go:build darwin && cgo

package wailsshell

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// 剪贴板里的文件路径（访达里拷贝的文件），换行分隔
static char *nomi_clipboard_files(void) {
	@autoreleasepool {
		NSArray<NSURL *> *urls = [[NSPasteboard generalPasteboard] readObjectsForClasses:@[ NSURL.class ]
			options:@{ NSPasteboardURLReadingFileURLsOnlyKey : @YES }];
		NSMutableArray<NSString *> *paths = [NSMutableArray array];
		for (NSURL *u in urls) if (u.path) [paths addObject:u.path];
		return strdup([[paths componentsJoinedByString:@"\n"] UTF8String] ?: "");
	}
}
*/
import "C"

import (
	"strings"
	"unsafe"
)

// ClipboardFilePaths = webUtils.getPathForFile 对粘贴文件的来源：剪贴板里的文件 URL
func (w *Wails) ClipboardFilePaths() []string {
	p := C.nomi_clipboard_files()
	defer C.free(unsafe.Pointer(p))
	var out []string
	for _, s := range strings.Split(C.GoString(p), "\n") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
