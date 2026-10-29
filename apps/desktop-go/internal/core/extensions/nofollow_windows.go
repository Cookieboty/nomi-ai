//go:build windows

package extensions

import (
	"os"
	"syscall"
)

// openNoFollow：O_NOFOLLOW 的 Windows 等价物。
// 用 FILE_FLAG_OPEN_REPARSE_POINT 打开“链接本身”而不是目标，再用句柄属性判断：
// 是重解析点（符号链接 / 目录联接）就拒绝，效果同 Unix 上 O_NOFOLLOW 的 ELOOP。
func openNoFollow(p string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil,
		syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(h, &info); err != nil {
		syscall.CloseHandle(h)
		return nil, &os.PathError{Op: "open", Path: p, Err: err}
	}
	if info.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		syscall.CloseHandle(h)
		return nil, &os.PathError{Op: "open", Path: p, Err: errLoop}
	}
	return os.NewFile(uintptr(h), p), nil
}

// errLoop：对应 ELOOP（Windows 无此 errno）
var errLoop = syscall.Errno(1921) // ERROR_CANT_RESOLVE_FILENAME
