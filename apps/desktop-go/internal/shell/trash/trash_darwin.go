//go:build darwin

package trash

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <stdlib.h>

// NSFileManager trashItemAtURL：静默移到废纸篓（可「放回原处」），
// 不经 Finder（osascript 会弹「控制 Finder」的自动化授权框，并播放 Finder 音效）。
// 失败返回 strdup 的错误描述，成功返回 NULL。
static char *nomiTrashItem(const char *path) {
	@autoreleasepool {
		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
		NSError *err = nil;
		if ([[NSFileManager defaultManager] trashItemAtURL:url resultingItemURL:nil error:&err]) {
			return NULL;
		}
		NSString *msg = err.localizedDescription ?: @"trashItemAtURL failed";
		return strdup(msg.UTF8String ? msg.UTF8String : "trashItemAtURL failed");
	}
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

func item(p string) error {
	cp := C.CString(p)
	defer C.free(unsafe.Pointer(cp))
	if e := C.nomiTrashItem(cp); e != nil {
		defer C.free(unsafe.Pointer(e))
		return errors.New(C.GoString(e))
	}
	return nil
}
