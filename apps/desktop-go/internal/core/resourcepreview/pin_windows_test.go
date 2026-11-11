//go:build windows

package resourcepreview

import (
	"os"

	"golang.org/x/sys/windows"
)

// pinFile keeps the original file identity allocated so a replacement at the
// same path cannot reuse it. os.Open does not share delete, so Remove fails
// with a sharing violation while that handle is open. This handle allows delete
// sharing, which is what lets the directory entry be replaced on Windows.
func pinFile(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}
