//go:build windows

package nodefs

import "syscall"

// errnoName：libuv uv_translate_sys_error 的常见 Win32 子集。
func errnoName(e syscall.Errno) string {
	switch e {
	case 1: // ERROR_INVALID_FUNCTION（ReadFile 读目录）→ libuv UV_EISDIR
		return "EISDIR"
	case 5, 1314: // ERROR_ACCESS_DENIED, ERROR_PRIVILEGE_NOT_HELD
		return "EPERM"
	case 80, 183: // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
		return "EEXIST"
	case 2, 3, 123: // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_NAME
		return "ENOENT"
	case 32, 33, 170: // SHARING_VIOLATION, LOCK_VIOLATION, BUSY
		return "EBUSY"
	case 112: // ERROR_DISK_FULL
		return "ENOSPC"
	case 206: // ERROR_FILENAME_EXCED_RANGE
		return "ENAMETOOLONG"
	case 87: // ERROR_INVALID_PARAMETER
		return "EINVAL"
	case 19: // ERROR_WRITE_PROTECT
		return "EROFS"
	case 267: // ERROR_DIRECTORY
		return "ENOTDIR"
	case 4390, 4393: // ERROR_NOT_A_REPARSE_POINT, ERROR_REPARSE_TAG_INVALID
		return "EINVAL"
	case 1921: // ERROR_CANT_RESOLVE_FILENAME
		return "ELOOP"
	}
	return ""
}
