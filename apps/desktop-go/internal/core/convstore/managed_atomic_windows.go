//go:build windows

package convstore

import (
	"os"

	"golang.org/x/sys/windows"
)

// Windows does not expose POSIX directory handle fsync; atomic publication
// relies on flushing the temp file buffers before calling MoveFileExW with
// MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH.
func syncDirectory(string) error {
	return nil
}

// Windows inherits directory ACLs rather than using POSIX 0600 mode bits.
func chmodPrivate(*os.File) error {
	return nil
}

func replaceFile(src, dst string) error {
	srcPtr, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	dstPtr, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(srcPtr, dstPtr, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
