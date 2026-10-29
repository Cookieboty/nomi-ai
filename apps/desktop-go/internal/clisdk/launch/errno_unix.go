//go:build !windows

package launch

import "syscall"

func errnoName(e syscall.Errno) string {
	switch e {
	case syscall.EEXIST:
		return "EEXIST"
	case syscall.EPERM:
		return "EPERM"
	case syscall.EACCES:
		return "EACCES"
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.EROFS:
		return "EROFS"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EINVAL:
		return "EINVAL"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	case syscall.EBUSY:
		return "EBUSY"
	case syscall.EIO:
		return "EIO"
	}
	return ""
}
